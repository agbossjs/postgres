import {
  Clock,
  PausedExecutionRepository,
  type PausedExecution,
  type PauseRecord,
} from "@agboss/core";
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";
import { pausedRunJsonOf, pausedRunOfJson } from "./framework-json.js";
import { PauseRows, recordOfRow } from "./paused/pause-rows.js";

const PausedRow = z.object({
  thread_id: z.string(),
  run_id: z.string(),
  run: z.string(),
  workflow_version: z.string(),
  config_hash: z.string(),
});

/**
 * The first layer of `PostgresPausedExecutionRepository`: one row per thread of a tenant — the
 * paused run and the versions it paused under — and the reads of a pause. The statements of the
 * pauses are in `paused/`; the connection and the clock are what the leaf class is given.
 */
export abstract class PostgresPausedRunRepository extends PausedExecutionRepository {
  constructor(
    protected readonly connection: PostgresConnection,
    private readonly clock: Clock,
  ) {
    super();
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
      `SELECT thread_id, run_id, run, workflow_version, config_hash FROM agboss_paused_executions
       WHERE tenant_id = $1 AND thread_id = $2`,
      [tenantId, threadId],
    );
    if (row === undefined) return undefined;
    const stored = PausedRow.parse(row);
    return {
      run: pausedRunOfJson(stored.run, { threadId: stored.thread_id, runId: stored.run_id }),
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

  /** One statement: a run saved since (another `run_id`) is never removed (I13). */
  async deleteByTenantIdAndThreadIdAndRunId(
    tenantId: string,
    threadId: string,
    runId: string,
  ): Promise<void> {
    await changesOf(
      this.connection.pool,
      `DELETE FROM agboss_paused_executions
       WHERE tenant_id = $1 AND thread_id = $2 AND run_id = $3`,
      [tenantId, threadId, runId],
    );
  }

  findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    return new PauseRows(this.connection.pool).findOrCreate(pause);
  }

  findByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<PauseRecord | undefined> {
    return new PauseRows(this.connection.pool).findById(tenantId, pauseId);
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly PauseRecord[]> {
    return new PauseRows(this.connection.pool).findAllByRoot(tenantId, rootExecutionId);
  }

  async findByTenantIdAndRootExecutionIdAndStepKey(
    tenantId: string,
    rootExecutionId: string,
    stepKey: string,
  ): Promise<PauseRecord | undefined> {
    const row = await new PauseRows(this.connection.pool).findByStepKey(
      tenantId,
      rootExecutionId,
      stepKey,
    );
    return row === undefined ? undefined : recordOfRow(row);
  }

  markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    return new PauseRows(this.connection.pool).markTaken(tenantId, pauseId);
  }
}
