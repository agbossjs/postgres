import type { PauseRecord } from "@agboss/core";
import {
  reassignChange,
  type PauseReassignmentChange,
  type PauseRecipients,
} from "@agboss/core/stores";
import type pg from "pg";
import { z } from "zod";
import { rowsOf } from "../../connection/query.js";
import { transitioned, type PauseKey } from "./pause-transition.js";

/**
 * A pause moved to another addressee (agbossjs/agboss#946, #1307): the core's `reassignChange` over
 * the pause row-locked and read and the step keys of its tree read in the same transaction — the
 * pause as it was seen, open at `at` or due, under the limits its record carries; then the pause
 * changed in place, or closed `Reassigned` with its replacement inserted `Pending` and unsent
 * (`transitioned`). Of two racing reassignments, or a reassignment and an answer, the row lock lets
 * exactly one change the pause: the other finds it changed and answers `undefined`.
 */

const KeyRow = z.object({ step_key: z.string() });

/** The pause moved as `change` says; the replacement (or, in place, the changed pause), or `undefined` when it does not apply at `at`. */
export function reassigned(
  pool: pg.Pool,
  target: PauseKey,
  change: PauseReassignmentChange,
  at: Date,
  recipients: PauseRecipients,
): Promise<PauseRecord | undefined> {
  return transitioned(pool, target, async (old, database) => {
    const rows = await rowsOf(
      database,
      "SELECT step_key FROM agboss_pauses WHERE tenant_id = $1 AND root_execution_id = $2",
      [old.tenantId, old.rootExecutionId],
    );
    const taken = new Set(rows.map((row) => KeyRow.parse(row).step_key));
    return reassignChange(old, change, taken, at, recipients);
  });
}
