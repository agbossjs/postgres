import {
  PauseResolution,
  PauseStatus,
  type PauseCancellation,
  type PauseRecord,
} from "@agboss/core";
import {
  NO_RECIPIENTS,
  type PauseAnswer,
  type PauseExpiry,
  type PauseRecipients,
  type PauseSeen,
  type PauseUntakenResolution,
} from "@agboss/core/stores";
import type pg from "pg";
import { firstRowOf } from "../../connection/query.js";
import { escapedJsonOf } from "../nul-escape.js";
import { appendNotices } from "./pause-notice-rows.js";
import { closedNotices, untakenNotices, type PlannedNotice } from "./pause-notice-plan.js";
import { changedWhen } from "./pause-heard.js";
import { recordOfRow } from "./pause-rows.js";

/**
 * The closers of a pending pause (agbossjs/agboss#935, #910): each is one compare-and-set `UPDATE …
 * WHERE status = <from> [AND <the deadline>] RETURNING record` — it row-locks the pause, so of two
 * instances exactly one changes it — and, when someone hears of the change, its notices appended in
 * the same transaction (`READ COMMITTED`): a notice is never without its change nor a change
 * without its notice. The deadline is compared in the database, in the statement that records the
 * change, so no answer is ever recorded at or after it, whatever the sweep did yet (I1, I2). A change
 * that names the pause it was planned against (`seen`, #1307) row-locks and reads it first and is
 * applied only while the core's `isSeenAs` holds — the same compare every store keeps — in the one
 * transaction with the statement; of an answer and an in-place reassignment exactly one wins.
 */

/** What a change writes with the pause it made: the notices its record asks for. */
export type NoticesOf = (after: PauseRecord) => readonly PlannedNotice[];

/** The `closed` notice of a record that was sent (an unsent pause's close tells no one: I8). */
const sentClosed =
  (at: Date, recipients: PauseRecipients): NoticesOf =>
  (after) =>
    after.isSent ? closedNotices(after, at, recipients) : [];

/** The deadline clause: `$4` is the transition's time. */
const OPEN = "AND (expires_at IS NULL OR expires_at > $4)";
const DUE = "AND expires_at IS NOT NULL AND expires_at <= $4";

/** The statement: the pause `$6` closed as the patch `$5` says, its status column `$3`, `resolved_at` `$4`. */
const closing = (extra: string, resolution: string): string =>
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
  /** The pause as the change was planned against: applied only while the pause is still that. */
  readonly seen?: PauseSeen | undefined;
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
    const guard = { tenantId, pauseId, seen: change.seen };
    return changedWhen(this.pool, recipients, guard, async (database) => {
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
    seen?: PauseSeen,
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
      seen,
    };
    return this.close(tenantId, pauseId, change, recipients, sentClosed(at, recipients));
  }

  /**
   * Its channel decided at once: never sent, no notice (I8). Only while the deadline is absent or
   * after `at` (as `resolve`: a decision at or after it is the expiry's) and the pause is still the
   * one the channel was sent (`seen`): an expiry's in-place reassignment during the first send makes
   * the decision stale.
   */
  async decide(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    seen: PauseSeen,
  ): Promise<boolean> {
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
      sql: closing(OPEN, "record || $5::jsonb"),
      seen,
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
          expiryProblem: expiry.problem, // undefined is no key in the JSON
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
