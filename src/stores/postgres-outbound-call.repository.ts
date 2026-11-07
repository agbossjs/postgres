import {
  StoreClock,
  Injectable,
  OutboundCallRepository,
  OutboundCallStatus,
  pendingOutboundCallOf,
  type StoreDescriptor,
  type EffectKey,
  type OutboundCallClaim,
  type OutboundCallFailure,
  type OutboundCallIntent,
  type OutboundCallLease,
  type OutboundCallLeaseState,
  type OutboundCallPage,
  type OutboundCallRecord,
  type OutboundCallStatusQuery,
  type OutboundCallState,
} from "@agboss/core";
import type { PoolClient } from "pg";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf, rowsOf } from "../connection/query.js";
import { inPoolTransaction } from "../connection/transaction.js";
import { checkFence } from "./fence.js";
import { storeNowOf } from "./store-time.js";
import { escapedText } from "./nul-escape.js";
import { leaseStateIn } from "./outbound-calls/lease-state.js";
import { callRecordOf, storedJsonOf, whereOf } from "./outbound-calls/outbound-call-rows.js";
import { z } from "zod";
import { idOfCursor, pageLimitOf } from "./outbound-call-pages.js";
import { assertKeyAtEntry } from "./key-entry.js";

/** A row of a page (agbossjs/agboss#825): its id, as text, and its record. */
const PagedRow = z.object({ id: z.string().regex(/^[1-9][0-9]*$/u), record: z.unknown() });

const SAVE = `INSERT INTO agboss_outbound_calls (scope_key, idempotency_key, name, tenant_id,
    root_execution_id, business_key, status, attempt, attempt_owner, ended_at, record)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10::jsonb)
  ON CONFLICT DO NOTHING`;

/** A record's last ending gone (`result`, `failure`, `endedAt`), the change's fields over it. */
const CHANGED_RECORD = "(record - 'result' - 'failure' - 'endedAt') || $1::jsonb";

/** The change of a compare-and-set: the columns set and the record's fields over the old ones. */
interface Change {
  readonly status: OutboundCallStatus;
  readonly attempt?: number;
  readonly attemptOwner?: string;
  readonly endedAt?: string;
  readonly fields: Partial<OutboundCallRecord>;
}

/** The state the row must still be in: its status and attempt owner, its attempt when given. */
interface AsRead {
  readonly status: OutboundCallStatus;
  readonly attempt?: number;
  readonly attemptOwner: string;
}

/**
 * `OutboundCallRepository` on PostgreSQL (agbossjs/agboss#505, #508): one row per intent in
 * `agboss_outbound_calls`, beside `agboss_execution_leases` and the scopes' marks of the fenced
 * effects. Every fenced method is one transaction at `READ COMMITTED`: the key's name, its lease
 * row `SELECT … FOR UPDATE` (held at its token, not released, not expired — else
 * `ExecutionFencedError`) and the scope's mark raised, then one statement. `saveIfAbsent` is an
 * `INSERT … ON CONFLICT DO NOTHING` on the unique index of the key's identity (by step, or by
 * tenant, name and business key), so of two savers exactly one records; every move is one
 * `UPDATE … WHERE` the row's status, attempt and attempt owner are as the caller read them — a
 * compare-and-set the row lock and PostgreSQL's re-check of the `WHERE` make atomic, also for one
 * business key moved under two leases that no lease lock serializes. `leaseStateOf` locks the
 * lease row and closes an expired one in the same transaction. Listed with
 * `PostgresExecutionLeaseRepository`, whose leases it reads.
 */
@Injectable({ deps: [PostgresConnection, StoreClock] })
export class PostgresOutboundCallRepository extends OutboundCallRepository {
  /** One transactional backend with the other PostgreSQL stores (agbossjs/agboss#526). */
  static override readonly store: StoreDescriptor = { backend: "postgres" };

  constructor(
    private readonly connection: PostgresConnection,
    private readonly clock: StoreClock,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  findByKey(key: EffectKey): Promise<OutboundCallRecord | undefined> {
    return this.#fenced(key, async (client, now) => {
      const [where, values] = whereOf(key, 1);
      const row = await firstRowOf(
        client,
        `SELECT record FROM agboss_outbound_calls WHERE ${where}`,
        values,
      );
      // read at the store's time the fence decided by (agbossjs/agboss#658), never stored
      return row === undefined ? undefined : { ...callRecordOf(row), readAt: now.toISOString() };
    });
  }

  saveIfAbsent(key: EffectKey, intent: OutboundCallIntent): Promise<boolean> {
    return this.#fenced(key, async (client, now) => {
      // its first attempt starts at the store's time (agbossjs/agboss#658: the database's own)
      const startedAt = now.toISOString();
      const record = {
        ...pendingOutboundCallOf(key, intent, this.clock.now()),
        attemptStartedAt: startedAt,
        firstAttemptStartedAt: startedAt,
      };
      const saved = await changesOf(client, SAVE, [
        key.scopeKey,
        escapedText(key.idempotencyKey),
        key.name,
        key.tenantId,
        intent.rootExecutionId,
        key.businessKey === undefined ? null : escapedText(key.businessKey),
        record.status,
        record.attempt,
        escapedText(record.attemptOwner),
        storedJsonOf(record),
      ]);
      return saved === 1;
    });
  }

  markPending(
    key: EffectKey,
    expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean> {
    const status = OutboundCallStatus.Pending;
    // the next attempt starts at the store's time (agbossjs/agboss#658); the first's start is kept
    return this.#moved(key, expected, (now) => ({
      status,
      ...claim,
      fields: { status, ...claim, attemptStartedAt: now.toISOString() },
    }));
  }

  markCompleted(key: EffectKey, attemptOwner: string, result: string): Promise<boolean> {
    const status = OutboundCallStatus.Completed;
    const endedAt = this.clock.now().toISOString();
    return this.#moved(key, { status: OutboundCallStatus.Pending, attemptOwner }, () => ({
      status,
      endedAt,
      fields: { status, result, endedAt },
    }));
  }

  markFailed(key: EffectKey, attemptOwner: string, failure: OutboundCallFailure): Promise<boolean> {
    const status = OutboundCallStatus.Failed;
    const endedAt = this.clock.now().toISOString();
    const { name, code, message } = failure;
    return this.#moved(key, { status: OutboundCallStatus.Pending, attemptOwner }, () => ({
      status,
      endedAt,
      fields: { status, failure: { name, code, message }, endedAt },
    }));
  }

  async findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly OutboundCallRecord[]> {
    const rows = await rowsOf(
      this.connection.pool,
      "SELECT record FROM agboss_outbound_calls WHERE tenant_id = $1 AND root_execution_id = $2 ORDER BY id",
      [tenantId, rootExecutionId],
    );
    return rows.map(callRecordOf);
  }

  /**
   * A page of a tenant's calls in `status` (agbossjs/agboss#825): keyset on the identity `id` — a row keeps its id
   * while it lives, an id is never reused — on the index `(tenant_id, status, id)`; the cursor is
   * the page's last id, as text (a `bigint`).
   */
  async findAllByTenantIdAndStatus(query: OutboundCallStatusQuery): Promise<OutboundCallPage> {
    const { tenantId, status, after } = query;
    const limit = pageLimitOf(query.limit);
    const rows = await rowsOf(
      this.connection.pool,
      "SELECT id::text AS id, record FROM agboss_outbound_calls WHERE tenant_id = $1 AND status = $2 AND id > $3::bigint ORDER BY id LIMIT $4",
      [tenantId, status, after === undefined ? "0" : idOfCursor(after), limit + 1],
    );
    const page = rows.slice(0, limit).map((row) => PagedRow.parse(row));
    const calls = page.map((row) => callRecordOf(row));
    const last = page.at(-1);
    return last === undefined || rows.length <= limit ? { calls } : { calls, next: last.id };
  }

  async deleteByEndedAtBefore(cutoff: Date): Promise<void> {
    await changesOf(
      this.connection.pool,
      "DELETE FROM agboss_outbound_calls WHERE ended_at IS NOT NULL AND ended_at < $1",
      [cutoff],
    );
  }

  leaseStateOf(lease: OutboundCallLease): Promise<OutboundCallLeaseState> {
    return inPoolTransaction(this.connection.pool, (client) =>
      leaseStateIn(client, lease, storeNowOf(this.clock)),
    );
  }

  /**
   * The compare-and-set of `key`'s row, fenced: `changeAt(now)` — `now` the store's time the fence
   * decided by — written under the key's lease and token only while the row is still `from`; one
   * statement, `true` when it changed the row.
   */
  #moved(key: EffectKey, from: AsRead, changeAt: (now: Date) => Change): Promise<boolean> {
    return this.#fenced(key, async (client, now) => {
      const change = changeAt(now);
      const fields = { ...change.fields, token: key.token, leaseExecutionId: key.leaseExecutionId };
      const [where, values] = whereOf(key, 5);
      const changed = await changesOf(
        client,
        `UPDATE agboss_outbound_calls SET record = ${CHANGED_RECORD}, status = $2,
           attempt = COALESCE($3::integer, attempt), attempt_owner = COALESCE($4::text, attempt_owner),
           ended_at = $8::timestamptz
         WHERE ${where} AND status = $9 AND ($10::integer IS NULL OR attempt = $10)
           AND attempt_owner = $11`,
        [
          storedJsonOf(fields),
          change.status,
          change.attempt ?? null,
          change.attemptOwner === undefined ? null : escapedText(change.attemptOwner),
          ...values,
          change.endedAt ?? null,
          from.status,
          from.attempt ?? null,
          escapedText(from.attemptOwner),
        ],
      );
      return changed === 1;
    });
  }

  /** `work` after the fencing checks (the lease row locked, the mark raised), in one transaction. */
  async #fenced<TValue>(
    key: EffectKey,
    work: (client: PoolClient, now: Date) => Promise<TValue>,
  ): Promise<TValue> {
    // the key's name, business key and fingerprint decision (agbossjs/agboss#508, #538, #825)
    assertKeyAtEntry(key);
    return inPoolTransaction(this.connection.pool, async (client) => {
      const now = await checkFence(client, key, storeNowOf(this.clock));
      return work(client, now);
    });
  }
}
