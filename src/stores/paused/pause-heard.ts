import { isSeenAs, type PauseRecipients, type PauseSeen } from "@agboss/core/stores";
import type pg from "pg";
import { firstRowOf, type Queryable } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { hasRecipients } from "./pause-notice-plan.js";
import { LOCKED_PAUSE, recordOfRow } from "./pause-rows.js";

/**
 * The transaction a change of a pause runs in (agbossjs/agboss#935, #1307): the one statement on the
 * pool when no one hears of it and it names no pause it was planned against, else a transaction
 * that holds the pause's row lock from its read.
 */

/** `work` in one transaction when anyone hears of the change, else on the pool (one statement). */
export function whenHeard<TResult>(
  pool: pg.Pool,
  recipients: PauseRecipients,
  work: (database: Queryable) => Promise<TResult>,
): Promise<TResult> {
  return hasRecipients(recipients) ? inPoolTransaction(pool, work) : work(pool);
}

/** The pause a change names and what it was planned against. */
export interface ChangeGuard {
  readonly tenantId: string;
  readonly pauseId: string;
  /** The pause as the change was planned against (`seenOf`): absent, the change is unguarded. */
  readonly seen?: PauseSeen | undefined;
}

/**
 * Whether the pause (row-locked here, until the transaction ends) is still the one `seen` names:
 * the core's `isSeenAs` over the record as stored — a pause that is none, or changed since, is not.
 */
async function isStillSeen(database: Queryable, guard: ChangeGuard & { seen: PauseSeen }) {
  const read = await firstRowOf(database, LOCKED_PAUSE, [guard.tenantId, guard.pauseId]);
  return read !== undefined && isSeenAs(recordOfRow(read), guard.seen);
}

/**
 * `work` as `whenHeard` runs it — and, when the change names the pause it was planned against, in a
 * transaction that first row-locks and reads the pause and goes on only while it is still that
 * (`undefined` otherwise, nothing written): of the change and an in-place reassignment exactly one wins.
 */
export function changedWhen<TResult>(
  pool: pg.Pool,
  recipients: PauseRecipients,
  guard: ChangeGuard,
  work: (database: Queryable) => Promise<TResult>,
): Promise<TResult | undefined> {
  const { seen } = guard;
  if (seen === undefined) return whenHeard(pool, recipients, work);
  return inPoolTransaction(pool, async (database) =>
    (await isStillSeen(database, { ...guard, seen })) ? work(database) : undefined,
  );
}
