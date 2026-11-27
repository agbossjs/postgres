import type { ExecutionHistoryQuery, Page, TenantExecutionHistoryQuery } from "@agboss/core/stores";
import { listingWindowOf, pageOfWindow, type ListingWindow } from "./listing-window.js";
import { inLongTransaction } from "../connection/transaction.js";
import { ExecutionHistoryRepository, Injectable, type ExecutionHistoryRecord } from "@agboss/core";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, rowsOf, type Parameters } from "../connection/query.js";
import { historyRecordOf } from "./history/history-rows.js";
import { escapedJsonOf } from "./nul-escape.js";

/** Replaces the row of the record's tenant and execution (the last save wins). */
const UPSERT = `INSERT INTO agboss_execution_history
    (tenant_id, execution_id, thread_id, started_at, ended_at, record)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  ON CONFLICT (tenant_id, execution_id) DO UPDATE SET
    thread_id = EXCLUDED.thread_id,
    started_at = EXCLUDED.started_at,
    ended_at = EXCLUDED.ended_at,
    record = EXCLUDED.record`;

/** Oldest start first; one start: by execution id, byte-wise (as SQLite orders text). */
const ORDER = `ORDER BY started_at, execution_id COLLATE "C"`;

const SELECT = "SELECT record FROM agboss_execution_history";

/** A time of the record (ISO 8601, the framework's `Clock`) as a `timestamptz` parameter. */
const momentOf = (iso: string | undefined): Date | null =>
  iso === undefined ? null : new Date(iso);

/**
 * `ExecutionHistoryRepository` on PostgreSQL (agbossjs/agboss#483): one row per kept root
 * execution, its record as `jsonb` beside the columns it is found by — tenant, execution, thread,
 * start and end. `save` is one upsert of the row (the same root saved twice keeps the last), so the
 * instances of an application share one history: `agboss executions export` on any of them lists
 * the executions of all. Reads are one `SELECT` each, oldest start first, ids ordered byte-wise;
 * the periods' reads are paged by `LIMIT` / `OFFSET` on the start indexes. The sweep's
 * `deleteByEndedAtBefore` removes only ended rows, by the `Clock`'s cutoff passed as a parameter.
 * Every statement runs alone at `READ COMMITTED`; no other locking. Listed in
 * `@Application({ providers })` with `postgresUrl` and `retention.executionRecords`.
 */
@Injectable({ deps: [PostgresConnection] })
export class PostgresExecutionHistoryRepository extends ExecutionHistoryRepository {
  constructor(private readonly connection: PostgresConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async save(record: ExecutionHistoryRecord): Promise<void> {
    await changesOf(this.connection.pool, UPSERT, [
      record.tenantId,
      record.executionId,
      record.threadId,
      momentOf(record.startedAt),
      momentOf(record.endedAt),
      escapedJsonOf(record),
    ]);
  }

  async findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<ExecutionHistoryRecord | undefined> {
    const [found] = await this.#where("tenant_id = $1 AND execution_id = $2", [
      tenantId,
      executionId,
    ]);
    return found;
  }

  findAllByExecutionId(executionId: string): Promise<ExecutionHistoryRecord[]> {
    return this.#where("execution_id = $1", [executionId]);
  }

  findAllByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<ExecutionHistoryRecord[]> {
    return this.#where("tenant_id = $1 AND thread_id = $2", [tenantId, threadId]);
  }

  async findAllByTenantIdAndStartedAtBetween(
    query: TenantExecutionHistoryQuery,
  ): Promise<Page<ExecutionHistoryRecord>> {
    const window = listingWindowOf(query);
    const found = await this.#where(
      "tenant_id = $1 AND started_at >= $2 AND started_at < $3",
      [query.tenantId, query.from, query.to],
      window,
    );
    return pageOfWindow(found, window);
  }

  async findAllByStartedAtBetween(
    query: ExecutionHistoryQuery,
  ): Promise<Page<ExecutionHistoryRecord>> {
    const window = listingWindowOf(query);
    const found = await this.#where(
      "started_at >= $1 AND started_at < $2",
      [query.from, query.to],
      window,
    );
    return pageOfWindow(found, window);
  }

  /** Removes the ended records that ended before `cutoff`; how many went. */
  deleteExpired(cutoff: Date): Promise<number> {
    return inLongTransaction(this.connection.pool, (client) =>
      changesOf(
        client,
        "DELETE FROM agboss_execution_history WHERE ended_at IS NOT NULL AND ended_at < $1",
        [cutoff],
      ),
    );
  }

  /** The records whose row matches `condition`, oldest start first; a page of them when given. */
  async #where(
    condition: string,
    parameters: Parameters,
    page?: ListingWindow,
  ): Promise<ExecutionHistoryRecord[]> {
    const next = parameters.length + 1;
    const paged = page === undefined ? "" : ` LIMIT $${String(next)} OFFSET $${String(next + 1)}`;
    const rows = await rowsOf(
      this.connection.pool,
      `${SELECT} WHERE ${condition} ${ORDER}${paged}`,
      page === undefined ? parameters : [...parameters, page.limit + 1, page.offset],
    );
    return rows.map(historyRecordOf);
  }
}
