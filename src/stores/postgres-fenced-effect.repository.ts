import {
  StoreClock,
  FencedEffectRepository,
  IdempotencyRunStatus,
  Injectable,
  type IdempotencyRunOutcome,
  type StoreDescriptor,
  type FencedEffectWork,
} from "@agboss/core";
import { replayedFromOf, storedKeyFactsOf, type EffectKey } from "@agboss/core/stores";
import { withAmbientTransaction } from "../connection/ambient.js";
import type { PoolClient } from "pg";
import { changesOf, firstRowOf } from "../connection/query.js";
import { inPoolTransaction, inLongTransaction } from "../connection/transaction.js";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { checkCancel } from "./cancel-fence.js";
import { checkFence } from "./fence.js";
import { storeNowOf } from "./store-time.js";
import { escapedJsonOf, unescapedJson } from "./nul-escape.js";
import { z } from "zod";
import { assertKeyAtEntry } from "./key-entry.js";
import { parsedOrUnreadable } from "./unreadable.js";

const ResultRow = z.object({ token: z.number(), result: z.string() });
/** What a business key's row keeps of the key that wrote it, for the core's `replayedFromOf`. */
const FactsRow = z.object({ fingerprint: z.string().nullable(), origin: z.unknown() });

/**
 * A business key's row (agbossjs/agboss#508), locked for the transaction first: its key is one for
 * every scope of the tenant, so no lease row serializes its writers — this transaction-scoped
 * advisory lock on the key's identity does (a hash collision only serializes two keys more).
 */
const LOCK_BUSINESS_KEY = "SELECT pg_advisory_xact_lock(hashtextextended($1, 508))";

/** The row of `key`: by its step, or by its tenant, name and business key. */
export async function storedRowOf(client: PoolClient, key: EffectKey): Promise<unknown> {
  if (key.businessKey === undefined)
    return firstRowOf(
      client,
      `SELECT token, result FROM agboss_fenced_effect_results
       WHERE scope_key = $1 AND idempotency_key = $2 AND name = $3`,
      [key.scopeKey, key.idempotencyKey, key.name],
    );
  await firstRowOf(client, LOCK_BUSINESS_KEY, [
    JSON.stringify([key.tenantId, key.name, key.businessKey]),
  ]);
  const read = (businessKey: string) =>
    firstRowOf(
      client,
      `SELECT token, result, fingerprint, origin FROM agboss_fenced_effect_business_results
       WHERE tenant_id = $1 AND name = $2 AND business_key = $3`,
      [key.tenantId, key.name, businessKey],
    );
  const found = await read(key.businessKey);
  // after a rotation of the idempotency secret: the row of the previous digest (#1317d)
  return found === undefined && key.previousBusinessKey !== undefined
    ? read(key.previousBusinessKey)
    : found;
}

/** Writes `key`'s result `text` under its token at `now`, in the table of its kind. */
async function insertRowOf(
  client: PoolClient,
  key: EffectKey,
  now: Date,
  text: string,
): Promise<void> {
  if (key.businessKey === undefined) {
    await changesOf(
      client,
      `INSERT INTO agboss_fenced_effect_results
         (scope_key, idempotency_key, name, token, stored_at, result, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [key.scopeKey, key.idempotencyKey, key.name, key.token, now, text, key.expiresAt],
    );
    return;
  }
  const { fingerprint, origin } = storedKeyFactsOf(key);
  await changesOf(
    client,
    `INSERT INTO agboss_fenced_effect_business_results
       (tenant_id, name, business_key, token, stored_at, result, fingerprint, origin, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      key.tenantId,
      key.name,
      key.businessKey,
      key.token,
      now,
      text,
      fingerprint ?? null,
      origin === undefined ? null : escapedJsonOf(origin),
      key.expiresAt,
    ],
  );
}

/** The replay of a stored row: its result, its token, the step it names (a business key's). */
function replayOf<TResult>(key: EffectKey, row: unknown): IdempotencyRunOutcome<TResult> {
  const { token, result } = ResultRow.parse(row);
  const facts = key.businessKey === undefined ? undefined : FactsRow.parse(row);
  const replayedFrom =
    facts === undefined
      ? undefined
      : replayedFromOf(key, {
          fingerprint: facts.fingerprint,
          // a stored `null` comes back as it is
          origin: unescapedJson(facts.origin),
        });
  return {
    status: IdempotencyRunStatus.Replayed,
    // written by this store as the JSON of the work's result
    result: parsedOrUnreadable("fenced effect result", result, { name: key.name }) as TResult,
    token,
    ...(replayedFrom === undefined ? {} : { replayedFrom }),
  };
}

/**
 * `FencedEffectRepository` on PostgreSQL (#500, #482): each scope's mark and each
 * effect's result beside `agboss_execution_leases`. One transaction at `READ COMMITTED` per call,
 * in the order of #500: the key's name, its lease row `SELECT … FOR UPDATE` (held by its epoch, not
 * released, not expired — else `ExecutionFencedError`), the mark raised to the token (a higher one
 * refuses it before any key is read), the key (found → `Replayed`), then the awaited `work(client)`
 * and its result. The row lock serializes two instances on one tree's effects (one `Ran`, the other
 * `Replayed`). A business key's effect (agbossjs/agboss#508) is one row per tenant, name and key in
 * `agboss_fenced_effect_business_results`, its writers serialized by an advisory transaction lock
 * on that identity — another fingerprint is `BusinessKeyConflictError`, a replay from another
 * step names it (`replayedFrom`). The work runs on the transaction's own connection, so it may
 * `await` its statements and a pool of one never deadlocks. Listed with
 * `PostgresExecutionLeaseRepository`, whose leases it reads.
 */
@Injectable({ deps: [PostgresConnection, StoreClock] })
export class PostgresFencedEffectRepository extends FencedEffectRepository {
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

  protected async runInTransaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    // the key's name, business key and fingerprint decision (agbossjs/agboss#508, #538, #825)
    assertKeyAtEntry(key);
    return inPoolTransaction(this.connection.pool, (client) =>
      // the work writes through `connection.requireTransaction()` — this transaction (#1317c)
      withAmbientTransaction(this.connection, client, () => this.#effect(client, key, work)),
    );
  }

  /**
   * Removes the results and marks whose `expires_at` has come (`<= now`); a row with none
   * (`Ttl.Forever`) is never removed. A scope's mark keeps the latest expiry of its keys. How many went.
   */
  async deleteExpired(now: Date): Promise<number> {
    return inLongTransaction(this.connection.pool, async (client) => {
      let removed = 0;
      for (const table of [
        "agboss_fenced_effect_results",
        "agboss_fenced_effect_business_results",
        "agboss_fenced_effect_marks",
      ])
        removed += await changesOf(
          client,
          `DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= $1`,
          [now],
        );
      return removed;
    });
  }

  async #effect<TResult>(
    client: PoolClient,
    key: EffectKey,
    work: FencedEffectWork<TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    const now = this.clock.now();
    await checkFence(client, key, storeNowOf(this.clock));
    const stored = await storedRowOf(client, key);
    if (stored !== undefined) return replayOf(key, stored);
    // agbossjs/agboss#909: no stored result — a new effect after a durable cancel is refused
    await checkCancel(client, key, storeNowOf(this.clock));
    const text = this.storedResultOf(key, await work());
    // the lease's time runs on while the work does: checked again before the row is written
    await checkFence(client, key, storeNowOf(this.clock));
    await insertRowOf(client, key, now, text);
    return {
      status: IdempotencyRunStatus.Ran,
      // the result as a replay gives it: its JSON parsed
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }
}
