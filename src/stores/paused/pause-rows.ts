import { PauseStatus, type PauseRecord } from "@agboss/core";
import type pg from "pg";
import { z } from "zod";
import { changesOf, firstRowOf, rowsOf } from "../../connection/query.js";
import { pauseRecordOf } from "../framework-json.js";
import { escapedJsonOf, unescapedJson } from "../nul-escape.js";

/**
 * The pauses of `PostgresPausedExecutionRepository` (#267 S35): one row per pause, unique per step
 * key of a tree (agbossjs/agboss#663: a step key names no tree, migration 0020), the record as
 * `jsonb` — it is where a pause's fields are, `isSent` and `resolution` included. The columns the
 * queries filter on (`status`, `resolved_at`, and since 0031 `expires_at`, `remind_at`, `channel`)
 * are mirrored in it, so a read never needs them; `seq` is the monotonic insertion sequence the
 * pages follow. A transition of a pending pause is one statement — the status column compared and
 * set, the record patched with it — so of two instances exactly one changes it (`pause-changes.ts`).
 */

const RecordRow = z.object({ record: z.unknown() });

/** The record a row keeps (what `RETURNING record` and `SELECT record` give). */
export const recordOfRow = (row: unknown): PauseRecord =>
  pauseRecordOf(unescapedJson(RecordRow.parse(row).record));

/** `SELECT … FOR UPDATE`'s row of one pause: locked until the transaction ends. */
export const LOCKED_PAUSE =
  "SELECT record FROM agboss_pauses WHERE tenant_id = $1 AND pause_id = $2 FOR UPDATE";

export class PauseRows {
  constructor(private readonly pool: pg.Pool) {}

  /** The pause of the step in its tenant's tree when one exists, else `pause` saved — one insert, then a read. */
  async findOrCreate(pause: PauseRecord): Promise<PauseRecord> {
    const inserted = await firstRowOf(
      this.pool,
      `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status,
         expires_at, remind_at, channel, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (tenant_id, root_execution_id, step_key) DO NOTHING RETURNING record`,
      [
        pause.tenantId,
        pause.pauseId,
        pause.stepKey,
        pause.rootExecutionId,
        pause.status,
        pause.expiresAt ?? null,
        pause.remindAt ?? null,
        pause.channel,
        escapedJsonOf(pause),
      ],
    );
    if (inserted !== undefined) return recordOfRow(inserted);
    return recordOfRow(
      await this.findByStepKey(pause.tenantId, pause.rootExecutionId, pause.stepKey),
    );
  }

  /** The pause of the step key in the tenant's tree (the 0020 unique key), one indexed read. */
  async findByStepKey(
    tenantId: string,
    rootExecutionId: string,
    stepKey: string,
  ): Promise<unknown> {
    return firstRowOf(
      this.pool,
      `SELECT record FROM agboss_pauses
       WHERE tenant_id = $1 AND root_execution_id = $2 AND step_key = $3`,
      [tenantId, rootExecutionId, stepKey],
    );
  }

  async findById(tenantId: string, pauseId: string): Promise<PauseRecord | undefined> {
    const row = await firstRowOf(
      this.pool,
      "SELECT record FROM agboss_pauses WHERE tenant_id = $1 AND pause_id = $2",
      [tenantId, pauseId],
    );
    return row === undefined ? undefined : recordOfRow(row);
  }

  async findAllByRoot(tenantId: string, rootExecutionId: string): Promise<readonly PauseRecord[]> {
    const rows = await rowsOf(
      this.pool,
      `SELECT record FROM agboss_pauses WHERE tenant_id = $1 AND root_execution_id = $2
       ORDER BY seq`,
      [tenantId, rootExecutionId],
    );
    return rows.map(recordOfRow);
  }

  /** A `Resolved` pause becomes `Taken`: its step took the decision. */
  async markTaken(tenantId: string, pauseId: string): Promise<void> {
    await changesOf(
      this.pool,
      `UPDATE agboss_pauses SET status = $3, record = jsonb_set(record, '{status}', to_jsonb($3::text))
       WHERE tenant_id = $1 AND pause_id = $2 AND status = $4`,
      [tenantId, pauseId, PauseStatus.Taken, PauseStatus.Resolved],
    );
  }
}
