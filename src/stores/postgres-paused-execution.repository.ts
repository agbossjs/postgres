import {
  Clock,
  Injectable,
  PausedExecutionRepository,
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseCancellation,
  type PausedExecution,
  type PauseRecord,
} from "@agboss/core";
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf, rowsOf } from "../connection/query.js";
import { pausedRunJsonOf, pausedRunOfJson, pauseRecordOf } from "./framework-json.js";
import { PauseRows } from "./paused/pause-rows.js";

const PausedRow = z.object({
  run: z.string(),
  workflow_version: z.string(),
  config_hash: z.string(),
});

/**
 * `PausedExecutionRepository` on PostgreSQL (#265, #267 S35, #482): one row per thread of a tenant
 * — the paused run and the versions it paused under — and one row per pause, the record as
 * `jsonb` with its status and resolution time as columns. Every transition of a pending pause is
 * one compare-and-set `UPDATE … WHERE status = 'pending' RETURNING`, so of two resumes on two
 * instances exactly one records its decision; the other gets nothing back — `NotPausedError`
 * from the core. With `PostgresCheckpointSaver` a pause made on one instance is resumed on any.
 * Listed in `@Application({ providers })` with `postgresUrl`.
 */
@Injectable({ deps: [PostgresConnection, Clock] })
export class PostgresPausedExecutionRepository extends PausedExecutionRepository {
  readonly #pauses: PauseRows;

  constructor(
    private readonly connection: PostgresConnection,
    private readonly clock: Clock,
  ) {
    super();
    this.#pauses = new PauseRows(connection.pool);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async findByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<PausedExecution | undefined> {
    const row = await firstRowOf(
      this.connection.pool,
      `SELECT run, workflow_version, config_hash FROM agboss_paused_executions
       WHERE tenant_id = $1 AND thread_id = $2`,
      [tenantId, threadId],
    );
    if (row === undefined) return undefined;
    const stored = PausedRow.parse(row);
    return {
      run: pausedRunOfJson(stored.run),
      workflowVersion: stored.workflow_version,
      configHash: stored.config_hash,
    };
  }

  async save(paused: PausedExecution): Promise<void> {
    const { run } = paused;
    await changesOf(
      this.connection.pool,
      `INSERT INTO agboss_paused_executions
         (tenant_id, thread_id, run_id, run, workflow_version, config_hash, paused_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, thread_id) DO UPDATE SET run_id = EXCLUDED.run_id,
         run = EXCLUDED.run, workflow_version = EXCLUDED.workflow_version,
         config_hash = EXCLUDED.config_hash, paused_at = EXCLUDED.paused_at`,
      [
        run.tenantId,
        run.threadId,
        run.runId,
        pausedRunJsonOf(run),
        paused.workflowVersion,
        paused.configHash,
        this.clock.now(),
      ],
    );
  }

  async deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void> {
    await changesOf(
      this.connection.pool,
      "DELETE FROM agboss_paused_executions WHERE tenant_id = $1 AND thread_id = $2",
      [tenantId, threadId],
    );
  }

  findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    return this.#pauses.findOrCreate(pause);
  }

  async findByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
  ): Promise<PauseRecord | undefined> {
    const row = await firstRowOf(
      this.connection.pool,
      "SELECT record FROM agboss_pauses WHERE tenant_id = $1 AND pause_id = $2",
      [tenantId, pauseId],
    );
    return row === undefined ? undefined : this.#pauses.recordOfRow(row);
  }

  async findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly PauseRecord[]> {
    const rows = await rowsOf(
      this.connection.pool,
      `SELECT record FROM agboss_pauses WHERE tenant_id = $1 AND root_execution_id = $2
       ORDER BY seq`,
      [tenantId, rootExecutionId],
    );
    return rows.map((row) => this.#pauses.recordOfRow(row));
  }

  markSentByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<boolean> {
    return this.#pauses.markSent(tenantId, pauseId);
  }

  async resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<PauseRecord | undefined> {
    const closed = await this.#pauses.close(tenantId, pauseId, {
      status: PauseStatus.Resolved,
      answer,
      resolution: PauseResolution.Replied,
      at,
    });
    return closed === undefined ? undefined : pauseRecordOf(closed);
  }

  async decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<boolean> {
    const closed = await this.#pauses.close(tenantId, pauseId, {
      status: PauseStatus.Taken,
      answer,
      resolution: PauseResolution.Decided,
      at,
    });
    return closed !== undefined;
  }

  async cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
  ): Promise<boolean> {
    const closed = await this.#pauses.close(tenantId, pauseId, {
      status: PauseStatus.Cancelled,
      resolution,
      at,
    });
    return closed !== undefined;
  }

  markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    return this.#pauses.markTaken(tenantId, pauseId);
  }

  deleteResolvedBefore(cutoff: Date): Promise<void> {
    return this.#pauses.deleteResolvedBefore(cutoff);
  }
}
