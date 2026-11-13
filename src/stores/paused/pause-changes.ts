import {
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseCancellation,
  type PauseRecord,
} from "@agboss/core";
import {
  NO_RECIPIENTS,
  type PauseExpiry,
  type PauseRecipients,
  type PauseUntakenResolution,
} from "@agboss/core/stores";
import type pg from "pg";
import { firstRowOf, type Queryable } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { escapedJsonOf } from "../nul-escape.js";
import { appendNotices } from "./pause-notice-rows.js";
import {
  closedNotices,
  hasRecipients,
  untakenNotices,
  type PlannedNotice,
} from "./pause-notice-plan.js";
import { recordOfRow } from "./pause-rows.js";

/**
 * The closers of a pending pause (agbossjs/agboss#935, #910): each is one compare-and-set `UPDATE …
 * WHERE status = <from> [AND <the deadline>] RETURNING record` — it row-locks the pause, so of two
 * instances exactly one changes it — and, when someone hears of the change, its notices appended in
 * the same transaction (`READ COMMITTED`): a notice is never without its change nor a change
 * without its notice. The deadline is compared in the database, in the statement that records the
 * change, so no answer is ever recorded at or after it, whatever the sweep did yet (I1, I2).
 */

/** What a change writes with the pause it made: the notices its record asks for. */
export type NoticesOf = (after: PauseRecord) => readonly PlannedNotice[];

/** `work` in one transaction when anyone hears of the change, else on the pool (one statement). */
export function whenHeard<TResult>(
  pool: pg.Pool,
  recipients: PauseRecipients,
  work: (database: Queryable) => Promise<TResult>,
): Promise<TResult> {
  return hasRecipients(recipients) ? inPoolTransaction(pool, work) : work(pool);
}

/** The `closed` notice of a record that was sent (an unsent pause's close tells no one: I8). */
const sentClosed =
  (at: Date, recipients: PauseRecipients): NoticesOf =>
  (after) =>
    after.isSent ? closedNotices(after, at, recipients) : [];

/** The deadline clause: `$4` is the transition's time. */
const OPEN = "AND (expires_at IS NULL OR expires_at > $4)";
const DUE = "AND expires_at IS NOT NULL AND expires_at <= $4";

/** The statement: the pause `$6` closed as the patch `$5` says, its status column `$3`, `resolved_at` `$4`. */
const closing = (extra: string, resolution = "record"): string =>
  `UPDATE agboss_pauses SET status = $3, resolved_at = $4, record = ${resolution}
   WHERE tenant_id = $1 AND pause_id = $2 AND status = $6 ${extra} RETURNING record`;

/** A closer's change: from `from` to `status`, the record patched, notices of the record it made. */
interface Closing {
  readonly from: PauseStatus;
  readonly status: PauseStatus;
  readonly patch: object;
  readonly at: Date;
  readonly sql: string;
  readonly extra?: readonly unknown[];
}

export class PauseChanges {
  constructor(private readonly pool: pg.Pool) {}

  /** The pause closed as `change` says, with the notices of what it became; `undefined` when it did not apply. */
  async close(
    tenantId: string,
    pauseId: string,
    change: Closing,
    recipients: PauseRecipients,
    notices: NoticesOf,
  ): Promise<PauseRecord | undefined> {
    return whenHeard(this.pool, recipients, async (database) => {
      const row = await firstRowOf(database, change.sql, [
        tenantId,
        pauseId,
        change.status,
        change.at,
        escapedJsonOf(change.patch),
        change.from,
        ...(change.extra ?? []),
      ]);
      if (row === undefined) return undefined;
      const after = recordOfRow(row);
      await appendNotices(database, tenantId, pauseId, notices(after));
      return after;
    });
  }

  resolve(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const patch = {
      status: PauseStatus.Resolved,
      resolution: PauseResolution.Replied,
      resolvedAt: at.toISOString(),
      answer,
    };
    const change = {
      from: PauseStatus.Pending,
      status: PauseStatus.Resolved,
      patch,
      at,
      sql: closing(OPEN, "record || $5::jsonb"),
    };
    return this.close(tenantId, pauseId, change, recipients, sentClosed(at, recipients));
  }

  /** Its channel decided at once: never sent, no notice (I8). */
  async decide(tenantId: string, pauseId: string, answer: PauseAnswer, at: Date): Promise<boolean> {
    const patch = {
      status: PauseStatus.Taken,
      resolution: PauseResolution.Decided,
      resolvedAt: at.toISOString(),
      answer,
    };
    const change = {
      from: PauseStatus.Pending,
      status: PauseStatus.Taken,
      patch,
      at,
      sql: closing("", "record || $5::jsonb"),
    };
    const decided = await this.close(tenantId, pauseId, change, NO_RECIPIENTS, () => []);
    return decided !== undefined;
  }

  /** A cancel or a tree end at or after `expiresAt` records `Expired` instead (I3), in the same statement. */
  cancel(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const expired = `CASE WHEN $7::text <> '${PauseResolution.Withdrawn}' AND expires_at IS NOT NULL
      AND expires_at <= $4 THEN '${PauseResolution.Expired}' ELSE $7::text END`;
    const change = {
      from: PauseStatus.Pending,
      status: PauseStatus.Cancelled,
      patch: { status: PauseStatus.Cancelled, resolvedAt: at.toISOString() },
      at,
      sql: closing("", `record || $5::jsonb || jsonb_build_object('resolution', ${expired})`),
      extra: [resolution],
    };
    return this.close(tenantId, pauseId, change, recipients, sentClosed(at, recipients));
  }

  /** The deadline passed: the channel's answer, else `Cancelled / Expired`; only while `expiresAt ≤ at`. */
  expire(
    tenantId: string,
    pauseId: string,
    expiry: PauseExpiry,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const resolvedAt = at.toISOString();
    const decided = expiry.answer !== undefined;
    const patch = decided
      ? {
          status: PauseStatus.Resolved,
          resolution: PauseResolution.DecidedOnExpiry,
          resolvedAt,
          answer: { ...expiry.answer, answeredBy: undefined },
        }
      : {
          status: PauseStatus.Cancelled,
          resolution: PauseResolution.Expired,
          resolvedAt,
          ...(expiry.problem === undefined ? {} : { expiryProblem: expiry.problem }),
        };
    const change = {
      from: PauseStatus.Pending,
      status: decided ? PauseStatus.Resolved : PauseStatus.Cancelled,
      patch,
      at,
      sql: closing(DUE, "record || $5::jsonb"),
    };
    return this.close(tenantId, pauseId, change, recipients, sentClosed(at, recipients));
  }

  /**
   * `Resolved → Cancelled` with `resolution` and `resolvedAt = at` — the not-taken marker — and the
   * first close's facts kept in `closedFirst` (#935 acceptance): the pause's resolution and
   * `resolvedAt` before, never over an existing `closedFirst`. An expiry-decided pause is then
   * still `Expired` at its deadline to the channel, a human answer `Answered` at its time.
   */
  closeUntaken(
    tenantId: string,
    pauseId: string,
    resolution: PauseUntakenResolution,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const first = `jsonb_build_object('closedFirst', COALESCE(record->'closedFirst',
      jsonb_build_object('resolution', record->'resolution', 'resolvedAt', record->'resolvedAt')))`;
    const change = {
      from: PauseStatus.Resolved,
      status: PauseStatus.Cancelled,
      patch: { status: PauseStatus.Cancelled, resolution, resolvedAt: at.toISOString() },
      at,
      sql: closing("", `record || $5::jsonb || ${first}`),
    };
    const notices: NoticesOf = (after) =>
      after.isSent ? untakenNotices(resolution, at, recipients) : [];
    return this.close(tenantId, pauseId, change, recipients, notices);
  }
}
