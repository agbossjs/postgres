import type { PauseRecord } from "@agboss/core";
import { assertPauseInstants, type PauseTransition } from "@agboss/core/stores";
import type pg from "pg";
import { firstRowOf, type Queryable } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { escapedJsonOf } from "../nul-escape.js";
import { appendNotices } from "./pause-notice-rows.js";
import { LOCKED_PAUSE, recordOfRow } from "./pause-rows.js";

/**
 * Every change of a pause (agbossjs/agboss#935, #1307): the pause row-locked and read
 * (`SELECT … FOR UPDATE`, the one transaction), the core's pure transition planned over the record as
 * read — the rule of the change, its `seen`, its deadline, its notices, the replacement it inserts
 * are the core's, the same every store reads —, then the pause written over the status it was read
 * at (a compare-and-set that stays even under the lock), its notices appended and its replacement
 * inserted, all in that transaction: a change is never without its notices nor a notice without its
 * change. Of two instances exactly one changes a pause; the other reads what the first wrote and
 * plans nothing. What is handed back is read from the database as written: no `Date` of the caller's
 * is ever in it, and none of it is the store's.
 */

/** The invariant a write of a row read under its lock breaks when it changes none. */
export const missed = (key: PauseKey): string =>
  `unreachable: 0 rows changed by a write of the pause ${key.pauseId} of ${key.tenantId}, read first under its row lock`;

/** The pause a change names. */
export interface PauseKey {
  readonly tenantId: string;
  readonly pauseId: string;
}

/** The transition a change makes of the pause as read; `undefined` when it does not apply. */
export type Plan = (
  pause: PauseRecord,
  database: Queryable,
) => PauseTransition | undefined | Promise<PauseTransition | undefined>;

/** The pause written as the transition made it: the status compared (`$3`), the columns mirroring the record set. */
const WRITE = `UPDATE agboss_pauses SET status = $4, resolved_at = $5::timestamptz,
    expires_at = $6::timestamptz, remind_at = $7::timestamptz, record = $8::jsonb
  WHERE tenant_id = $1 AND pause_id = $2 AND status = $3 RETURNING record`;

/** The pause as the transition left it, `Date`s bound as `timestamptz`, the record as its own JSON text. */
export async function writtenPause(
  database: Queryable,
  before: PauseRecord,
  after: PauseRecord,
): Promise<PauseRecord | undefined> {
  assertPauseInstants(after);
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

/** The replacement's row: `Pending`, its deadline and reminder columns mirroring its record. */
async function insertedPause(database: Queryable, made: PauseRecord): Promise<PauseRecord> {
  const row = await firstRowOf(
    database,
    `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status,
       expires_at, remind_at, record) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::jsonb)
     RETURNING record`,
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
  return recordOfRow(row);
}

/**
 * The pause changed as `plan` says, with its notices; the pause as written — or, when the change
 * inserts a replacement, the replacement — and `undefined` when the pause is none or the transition
 * does not apply (nothing written). An Invalid Date in what the transition made is refused before the
 * first write.
 */
export function transitioned(
  pool: pg.Pool,
  key: PauseKey,
  plan: Plan,
): Promise<PauseRecord | undefined> {
  return inPoolTransaction(pool, async (database) => {
    const read = await firstRowOf(database, LOCKED_PAUSE, [key.tenantId, key.pauseId]);
    if (read === undefined) return undefined;
    const before = recordOfRow(read);
    const change = await plan(before, database);
    if (change === undefined) return undefined;
    if (change.inserted !== undefined) assertPauseInstants(change.inserted);
    const written = await writtenPause(database, before, change.pause);
    // the row is locked and was read a moment ago: a miss is the record and the status column disagreeing
    // (damage), never a lost race — a loud failure that rolls the transaction back, as the core's SQLite store
    if (written === undefined) throw new Error(missed(key));
    await appendNotices(database, key.tenantId, key.pauseId, change.notices);
    return change.inserted === undefined ? written : insertedPause(database, change.inserted);
  });
}
