import {
  PauseStatus,
  type PauseAnswer,
  type PauseRecord,
  type PauseResolution,
} from "@agboss/core";
import type pg from "pg";
import { z } from "zod";
import { changesOf, firstRowOf } from "../../connection/query.js";
import { pauseRecordOf } from "../framework-json.js";
import { escapedJsonOf, unescapedJson } from "../nul-escape.js";

/**
 * The pauses of `PostgresPausedExecutionRepository` (#267 S35): one row per pause, unique per step
 * key of a tree (agbossjs/agboss#663: a step key names no tree, migration 0020), the record as `jsonb`. A transition of a pending pause is one statement — the
 * status column compared and set, the record patched with it — so of two instances exactly one
 * changes it, and the record is never out of step with its status.
 */

/** How a pending pause closes: its new status, how and when, and the answer when it has one. */
export interface PauseClosing {
  readonly status: PauseStatus;
  readonly resolution: PauseResolution;
  readonly at: Date;
  readonly answer?: PauseAnswer;
}

const RecordRow = z.object({ record: z.unknown() });

/** A pending pause closed as `closing` says: the record's fields, then its status column. */
const CLOSE = `UPDATE agboss_pauses SET status = $3, resolved_at = $4, record = record || $5::jsonb
  WHERE tenant_id = $1 AND pause_id = $2 AND status = 'pending' RETURNING record`;

export class PauseRows {
  constructor(private readonly pool: pg.Pool) {}

  /** The record a row keeps. */
  recordOfRow(row: unknown): PauseRecord {
    return pauseRecordOf(unescapedJson(RecordRow.parse(row).record));
  }

  /** The pause of the step in its tenant's tree when one exists, else `pause` saved — one insert, then a read. */
  async findOrCreate(pause: PauseRecord): Promise<PauseRecord> {
    const inserted = await firstRowOf(
      this.pool,
      `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status, record)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (tenant_id, root_execution_id, step_key) DO NOTHING RETURNING record`,
      [
        pause.tenantId,
        pause.pauseId,
        pause.stepKey,
        pause.rootExecutionId,
        pause.status,
        escapedJsonOf(pause),
      ],
    );
    if (inserted !== undefined) return this.recordOfRow(inserted);
    const found = await firstRowOf(
      this.pool,
      `SELECT record FROM agboss_pauses
       WHERE tenant_id = $1 AND root_execution_id = $2 AND step_key = $3`,
      [pause.tenantId, pause.rootExecutionId, pause.stepKey],
    );
    return this.recordOfRow(found);
  }

  /** `true` when the pause was pending and is now marked sent. */
  async markSent(tenantId: string, pauseId: string): Promise<boolean> {
    const changed = await changesOf(
      this.pool,
      `UPDATE agboss_pauses SET record = jsonb_set(record, '{isSent}', 'true')
       WHERE tenant_id = $1 AND pause_id = $2 AND status = 'pending'`,
      [tenantId, pauseId],
    );
    return changed === 1;
  }

  /** The pending pause closed; the record as stored now, `undefined` when it was not pending. */
  async close(tenantId: string, pauseId: string, closing: PauseClosing): Promise<unknown> {
    const patch = {
      status: closing.status,
      resolution: closing.resolution,
      resolvedAt: closing.at.toISOString(),
      ...(closing.answer === undefined ? {} : { answer: closing.answer }),
    };
    const row = await firstRowOf(this.pool, CLOSE, [
      tenantId,
      pauseId,
      closing.status,
      closing.at,
      escapedJsonOf(patch),
    ]);
    return row === undefined ? undefined : unescapedJson(RecordRow.parse(row).record);
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

  /** Removes every `Taken` and `Cancelled` pause of every tenant resolved before `cutoff`. */
  async deleteResolvedBefore(cutoff: Date): Promise<void> {
    await changesOf(
      this.pool,
      `DELETE FROM agboss_pauses WHERE status = ANY($1::text[]) AND resolved_at < $2`,
      [[PauseStatus.Taken, PauseStatus.Cancelled], cutoff],
    );
  }
}
