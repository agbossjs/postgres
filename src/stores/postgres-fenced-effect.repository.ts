import {
  Clock,
  ExecutionFencedError,
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
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";
import { inPoolTransaction } from "../connection/transaction.js";
import { PostgresExecutionLeaseRepository } from "./postgres-execution-lease.repository.js";

/** The key's lease row, locked for the transaction: a renewal or a takeover of it waits. */
const LOCK_LEASE = `SELECT lease_epoch, expires_at, released FROM agboss_execution_leases
  WHERE tenant_id = $1 AND root_execution_id = $2 FOR UPDATE`;

/** Raises the scope's mark to the token (never lowers it); the mark as it is now. */
const RAISE_MARK = `INSERT INTO agboss_fenced_effect_marks AS mark (scope_key, highest_token, stored_at)
  VALUES ($1, $2, $3)
  ON CONFLICT (scope_key) DO UPDATE SET
    highest_token = GREATEST(mark.highest_token, EXCLUDED.highest_token),
    stored_at = EXCLUDED.stored_at
  RETURNING highest_token`;

const LeaseRow = z.object({ lease_epoch: z.number(), expires_at: z.date(), released: z.boolean() });
const MarkRow = z.object({ highest_token: z.number() });
const ResultRow = z.object({ token: z.number(), result: z.string() });

/**
 * `FencedEffectRepository<PoolClient>` on PostgreSQL (#500, #482): each scope's mark and each
 * effect's result in two tables beside `agboss_execution_leases`. One transaction at `READ
 * COMMITTED` per call, in the order of #500: the key's lease row `SELECT … FOR UPDATE` (held by
 * its epoch, not released, not expired — else `ExecutionFencedError`), the mark raised to the
 * token (a higher one refuses it before any key is read), the key (found → `Replayed`), then the
 * awaited `work(client)` and its result. The row lock serializes two instances on one tree's
 * effects (one `Ran`, the other `Replayed`); the work runs on the transaction's own connection,
 * so it may `await` its statements and a pool of one never deadlocks. Listed with
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

  protected runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<PoolClient, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    return inPoolTransaction(this.connection.pool, (client) => this.#effect(client, key, work));
  }

  async deleteByStoredAtBefore(cutoff: Date): Promise<void> {
    await inPoolTransaction(this.connection.pool, async (client) => {
      await changesOf(client, "DELETE FROM agboss_fenced_effect_results WHERE stored_at < $1", [
        cutoff,
      ]);
      await changesOf(client, "DELETE FROM agboss_fenced_effect_marks WHERE stored_at < $1", [
        cutoff,
      ]);
    });
  }

  async #effect<TResult>(
    client: PoolClient,
    key: FencedEffectKey,
    work: FencedEffectWork<PoolClient, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    const now = this.clock.now();
    await this.#checkFence(client, key, now);
    const stored = await firstRowOf(
      client,
      `SELECT token, result FROM agboss_fenced_effect_results
       WHERE scope_key = $1 AND idempotency_key = $2 AND name = $3`,
      [key.scopeKey, key.idempotencyKey, key.name],
    );
    if (stored !== undefined) {
      const { token, result } = ResultRow.parse(stored);
      return { status: FencedEffectStatus.Replayed, result: JSON.parse(result) as TResult, token };
    }
    const text = this.storedResultOf(key, await work(client));
    await changesOf(
      client,
      `INSERT INTO agboss_fenced_effect_results
         (scope_key, idempotency_key, name, token, stored_at, result) VALUES ($1, $2, $3, $4, $5, $6)`,
      [key.scopeKey, key.idempotencyKey, key.name, key.token, now, text],
    );
    return {
      status: FencedEffectStatus.Ran,
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }

  /** The key's lease is held (its epoch, not released, not expired) and no newer token wrote the scope. */
  async #checkFence(client: PoolClient, key: FencedEffectKey, now: Date): Promise<void> {
    const { scopeKey, token } = key;
    const row = await firstRowOf(client, LOCK_LEASE, [key.tenantId, key.leaseExecutionId]);
    const lease = row === undefined ? undefined : LeaseRow.parse(row);
    const isHeld =
      lease !== undefined &&
      !lease.released &&
      lease.lease_epoch === token &&
      lease.expires_at.getTime() > now.getTime();
    if (!isHeld)
      throw new ExecutionFencedError({ scopeKey, token, observedToken: lease?.lease_epoch });
    const mark = MarkRow.parse(await firstRowOf(client, RAISE_MARK, [scopeKey, token, now]));
    if (mark.highest_token > token)
      throw new ExecutionFencedError({ scopeKey, token, observedToken: mark.highest_token });
  }
}
