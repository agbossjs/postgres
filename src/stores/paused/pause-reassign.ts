import type { PauseRecord } from "@agboss/core";
import type { PauseReassignmentChange, PauseRecipients } from "@agboss/core/stores";
import type pg from "pg";
import { z } from "zod";
import { firstRowOf, rowsOf, type Queryable } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { escapedJsonOf } from "../nul-escape.js";
import { appendNotices } from "./pause-notice-rows.js";
import { reassignPlan } from "./pause-reassign-plan.js";
import { LOCKED_PAUSE, recordOfRow } from "./pause-rows.js";

/**
 * A pause moved to another addressee (agbossjs/agboss#946, #1307): one transaction — the pause
 * row-locked and read, the step keys of its tree read, the change planned (`reassignPlan`: the pause
 * as it was seen, open at `at` or due, under its limits), the pause written over the status it was
 * read at, its notices appended, and a replacement inserted `Pending` and unsent. Of two racing
 * reassignments, or a reassignment and an answer, the row lock lets exactly one change the pause:
 * the other finds it changed and answers `undefined`.
 */

const KeyRow = z.object({ step_key: z.string() });

/** The pause written as the plan made it: the status column compared (`$2`), the columns mirroring the record set. */
const WRITE = `UPDATE agboss_pauses SET status = $4, resolved_at = $5::timestamptz,
    expires_at = $6::timestamptz, remind_at = $7::timestamptz, record = $8::jsonb
  WHERE tenant_id = $1 AND pause_id = $2 AND status = $3 RETURNING record`;

/** The replacement's row: its deadline and reminder columns mirror its record. */
async function insertedReplacement(database: Queryable, made: PauseRecord): Promise<void> {
  await firstRowOf(
    database,
    `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status,
       expires_at, remind_at, record) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::jsonb)`,
    [
      made.tenantId,
      made.pauseId,
      made.stepKey,
      made.rootExecutionId,
      made.expiresAt ?? null,
      made.remindAt ?? null,
      escapedJsonOf(made),
    ],
  );
}

/** The change applied to the pause read and locked: its row written over its status, or `undefined` (a lost race). */
export async function writtenPause(
  database: Queryable,
  before: PauseRecord,
  after: PauseRecord,
): Promise<PauseRecord | undefined> {
  const row = await firstRowOf(database, WRITE, [
    before.tenantId,
    before.pauseId,
    before.status,
    after.status,
    after.resolvedAt ?? null,
    after.expiresAt ?? null,
    after.remindAt ?? null,
    escapedJsonOf(after),
  ]);
  return row === undefined ? undefined : recordOfRow(row);
}

/** The pause moved as `change` says; the replacement (or, in place, the changed pause), or `undefined` when it does not apply at `at`. */
export function reassigned(
  pool: pg.Pool,
  target: { readonly tenantId: string; readonly pauseId: string },
  change: PauseReassignmentChange,
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
    const plan = reassignPlan(old, change, taken, at, recipients);
    if (plan === undefined) return undefined;
    if ((await writtenPause(database, old, plan.pause)) === undefined) return undefined;
    await appendNotices(database, tenantId, pauseId, plan.notices);
    if (plan.inserted === undefined) return plan.pause;
    await insertedReplacement(database, plan.inserted);
    return plan.inserted;
  });
}
