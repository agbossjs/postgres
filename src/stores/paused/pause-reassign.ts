import { PauseResolution, PauseStatus, type PauseRecord } from "@agboss/core";
import {
  replacementStepKeyOf,
  type PauseRecipients,
  type PauseReplacement,
} from "@agboss/core/stores";
import type pg from "pg";
import { z } from "zod";
import { firstRowOf, rowsOf } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { escapedJsonOf } from "../nul-escape.js";
import { closedNotices } from "./pause-notice-plan.js";
import { appendNotices } from "./pause-notice-rows.js";
import { LOCKED_PAUSE, recordOfRow } from "./pause-rows.js";

/**
 * A pause moved to another addressee (agbossjs/agboss#946): one transaction — the old pause row-locked
 * and read, the step keys of its tree read, the old pause written `Cancelled` / `Reassigned` (the
 * status column compared and the deadline checked in the statement, so no reassignment follows an
 * answer or the deadline), its `closed` notices appended when it was sent (I7), and the replacement
 * inserted `Pending` and unsent. Of two racing reassignments, or a reassignment and an answer, the row
 * lock lets exactly one change the pause: the other finds it no longer `Pending` and answers
 * `undefined`.
 */

const KeyRow = z.object({ step_key: z.string() });

/** The old pause closed as reassigned: the status column compared (`$5`), the deadline after `$3`. */
const REASSIGN = `UPDATE agboss_pauses SET status = 'cancelled', resolved_at = $3,
    record = record || $4::jsonb
  WHERE tenant_id = $1 AND pause_id = $2 AND status = 'pending'
    AND (expires_at IS NULL OR expires_at > $3) RETURNING record`;

/** The replacement of `old`: a copy for another addressee, unsent, asked at `at` (a reassignment is no new deadline). */
const replacementOf = (
  old: PauseRecord,
  replacement: PauseReplacement,
  stepKey: string,
  at: Date,
): PauseRecord => ({
  ...old,
  pauseId: replacement.pauseId,
  assignee: replacement.assignee,
  stepKey,
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: at.toISOString(),
  reassignedFrom: old.pauseId,
});

/** `old` moved to `replacement`'s addressee; the replacement, or `undefined` when the pause is not open at `at`. */
export function reassigned(
  pool: pg.Pool,
  target: { readonly tenantId: string; readonly pauseId: string },
  replacement: PauseReplacement,
  at: Date,
  recipients: PauseRecipients,
): Promise<PauseRecord | undefined> {
  const { tenantId, pauseId } = target;
  return inPoolTransaction(pool, async (database) => {
    const read = await firstRowOf(database, LOCKED_PAUSE, [tenantId, pauseId]);
    if (read === undefined) return undefined;
    const old = recordOfRow(read);
    const taken = new Set(
      (
        await rowsOf(
          database,
          "SELECT step_key FROM agboss_pauses WHERE tenant_id = $1 AND root_execution_id = $2",
          [tenantId, old.rootExecutionId],
        )
      ).map((row) => KeyRow.parse(row).step_key),
    );
    const patch = {
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Reassigned,
      resolvedAt: at.toISOString(),
      reassignedTo: replacement.pauseId,
    };
    const closed = await firstRowOf(database, REASSIGN, [
      tenantId,
      pauseId,
      at,
      escapedJsonOf(patch),
    ]);
    if (closed === undefined) return undefined;
    const after = recordOfRow(closed);
    if (after.isSent)
      await appendNotices(database, tenantId, pauseId, closedNotices(after, at, recipients));
    const made = replacementOf(old, replacement, replacementStepKeyOf(old, taken), at);
    await firstRowOf(
      database,
      `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status,
         expires_at, remind_at, record) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::jsonb)`,
      [
        tenantId,
        made.pauseId,
        made.stepKey,
        made.rootExecutionId,
        made.expiresAt ?? null,
        made.remindAt ?? null,
        escapedJsonOf(made),
      ],
    );
    return made;
  });
}
