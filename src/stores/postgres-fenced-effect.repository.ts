import {
  Clock,
  FencedEffectRepository,
  FencedEffectSettings,
  FencedEffectStatus,
  Injectable,
  type Class,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
} from "@agboss/core";
import type { PoolClient } from "pg";
import { changesOf, firstRowOf } from "../connection/query.js";
import { inPoolTransaction } from "../connection/transaction.js";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { replayedFromOf, StoredFacts } from "./business-keys.js";
import { checkedName, checkFence } from "./fence.js";
import { escapedJsonOf, unescapedJson } from "./nul-escape.js";
import { PostgresExecutionLeaseRepository } from "./postgres-execution-lease.repository.js";
import { z } from "zod";

const ResultRow = z.object({ token: z.number(), result: z.string() });

/**
 * A business key's row (agbossjs/agboss#508), locked for the transaction first: its key is one for
 * every scope of the tenant, so no lease row serializes its writers — this transaction-scoped
 * advisory lock on the key's identity does (a hash collision only serializes two keys more).
 */
const LOCK_BUSINESS_KEY = "SELECT pg_advisory_xact_lock(hashtextextended($1, 508))";

/** The row of `key`: by its step, or by its tenant, name and business key. */
async function storedRowOf(client: PoolClient, key: FencedEffectKey): Promise<unknown> {
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
  return firstRowOf(
    client,
    `SELECT token, result, fingerprint, origin FROM agboss_fenced_effect_business_results
     WHERE tenant_id = $1 AND name = $2 AND business_key = $3`,
    [key.tenantId, key.name, key.businessKey],
  );
}

/** Writes `key`'s result `text` under its token at `now`, in the table of its kind. */
async function insertRowOf(
  client: PoolClient,
  key: FencedEffectKey,
  now: Date,
  text: string,
): Promise<void> {
  if (key.businessKey === undefined) {
    await changesOf(
      client,
      `INSERT INTO agboss_fenced_effect_results
         (scope_key, idempotency_key, name, token, stored_at, result) VALUES ($1, $2, $3, $4, $5, $6)`,
      [key.scopeKey, key.idempotencyKey, key.name, key.token, now, text],
    );
    return;
  }
  const origin = key.origin === undefined ? null : escapedJsonOf(key.origin);
  await changesOf(
    client,
    `INSERT INTO agboss_fenced_effect_business_results
       (tenant_id, name, business_key, token, stored_at, result, fingerprint, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      key.tenantId,
      key.name,
      key.businessKey,
      key.token,
      now,
      text,
      key.fingerprint ?? null,
      origin,
    ],
  );
}

/** The replay of a stored row: its result, its token, the step it names (a business key's). */
function replayOf<TResult>(key: FencedEffectKey, row: unknown): FencedEffectOutcome<TResult> {
  const { token, result } = ResultRow.parse(row);
  const facts = key.businessKey === undefined ? undefined : StoredFacts.parse(row);
  const replayedFrom =
    facts === undefined
      ? undefined
      : replayedFromOf(key, {
          fingerprint: facts.fingerprint,
          origin: facts.origin === null ? null : unescapedJson(facts.origin),
        });
  return {
    status: FencedEffectStatus.Replayed,
    // written by this store as the JSON of the work's result
    result: JSON.parse(result) as TResult,
    token,
    ...(replayedFrom === undefined ? {} : { replayedFrom }),
  };
}

/**
 * `FencedEffectRepository<PoolClient>` on PostgreSQL (#500, #482): each scope's mark and each
 * effect's result beside `agboss_execution_leases`. One transaction at `READ COMMITTED` per call,
 * in the order of #500: the key's name, its lease row `SELECT … FOR UPDATE` (held by its epoch, not
 * released, not expired — else `ExecutionFencedError`), the mark raised to the token (a higher one
 * refuses it before any key is read), the key (found → `Replayed`), then the awaited `work(client)`
 * and its result. The row lock serializes two instances on one tree's effects (one `Ran`, the other
 * `Replayed`). A business key's effect (agbossjs/agboss#508) is one row per tenant, name and key in
 * `agboss_fenced_effect_business_results`, its writers serialized by an advisory transaction lock
 * on that identity — another fingerprint is `IdempotencyKeyConflictError`, a replay from another
 * step names it (`replayedFrom`). The work runs on the transaction's own connection, so it may
 * `await` its statements and a pool of one never deadlocks. Listed with
 * `PostgresExecutionLeaseRepository`, whose leases it reads.
 */
@Injectable({ deps: [PostgresConnection, Clock, FencedEffectSettings] })
export class PostgresFencedEffectRepository extends FencedEffectRepository<PoolClient> {
  static override readonly leaseRepository: Class | undefined = PostgresExecutionLeaseRepository;

  constructor(
    private readonly connection: PostgresConnection,
    private readonly clock: Clock,
    settings: FencedEffectSettings,
  ) {
    super(settings);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  protected async runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<PoolClient, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    checkedName(key);
    return inPoolTransaction(this.connection.pool, (client) => this.#effect(client, key, work));
  }

  async deleteByStoredAtBefore(cutoff: Date): Promise<void> {
    await inPoolTransaction(this.connection.pool, async (client) => {
      for (const table of [
        "agboss_fenced_effect_results",
        "agboss_fenced_effect_business_results",
        "agboss_fenced_effect_marks",
      ])
        await changesOf(client, `DELETE FROM ${table} WHERE stored_at < $1`, [cutoff]);
    });
  }

  async #effect<TResult>(
    client: PoolClient,
    key: FencedEffectKey,
    work: FencedEffectWork<PoolClient, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    const now = this.clock.now();
    await checkFence(client, key, now);
    const stored = await storedRowOf(client, key);
    if (stored !== undefined) return replayOf(key, stored);
    const text = this.storedResultOf(key, await work(client));
    await insertRowOf(client, key, now, text);
    return {
      status: FencedEffectStatus.Ran,
      // the result as a replay gives it: its JSON parsed
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }
}
