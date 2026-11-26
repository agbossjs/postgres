import type { PauseRecord, PauseTrailRecord } from "@agboss/core";
import {
  isSeenAs,
  PauseExpiryBound,
  PauseNoticeKind,
  type PauseRecipients,
  type PauseTimeoutChange,
} from "@agboss/core/stores";
import { noticesOf, type PlannedNotice } from "./pause-notice-plan.js";
import { countOf, isOpenAt, isWithinCap } from "./pause-open.js";

/**
 * What a deadline change and a send make of a pause (agbossjs/agboss#942, #1099, #1307), restated
 * from the core's pure transitions (`pause-timeout-change.ts`, `pause-transitions.ts`), which no
 * public entry exports yet. The plan is made over the record read under the pause's row lock, so the
 * checks below are atomic with the write that follows.
 */

/** The entry a deadline change adds to the chain of custody: who moved it, when, to what, why. */
function timeoutChangedEntryOf(
  pause: PauseRecord,
  change: PauseTimeoutChange,
  at: Date,
): PauseTrailRecord {
  return {
    action: "timeout-changed",
    at: at.toISOString(),
    ...(change.actor === undefined ? {} : { actor: change.actor }),
    target: pause.target,
    ...(pause.channel === undefined ? {} : { channel: pause.channel }),
    ...(pause.assignees === undefined ? {} : { assignees: pause.assignees }),
    ...(change.expiresAt === undefined ? {} : { expiresAt: change.expiresAt }),
    ...(pause.externalRef === undefined ? {} : { externalRef: pause.externalRef }),
    ...(change.reason === undefined ? {} : { reason: change.reason }),
  };
}

/**
 * Whether the change applies to the pause now: open at `at`, over the deadline the caller read (absent:
 * none) and the pause as it was read, to none or to a time after `at` (never to a past time, I3), within
 * the cap the record holds (`maxExpiresAt`), and under the count of changes the record's own
 * `escalationLimits.maxExtensions` allows — never the caller's say, never the configuration's.
 */
function isChangeable(pause: PauseRecord, change: PauseTimeoutChange, at: Date): boolean {
  if (!isOpenAt(pause, at)) return false;
  if (pause.expiresAt !== change.previousExpiresAt || !isSeenAs(pause, change.seen)) return false;
  if (change.expiresAt !== undefined && change.expiresAt <= at.toISOString()) return false;
  if (!isWithinCap(pause.maxExpiresAt, change.expiresAt)) return false;
  return countOf(pause, "timeout-changed") < (pause.escalationLimits.maxExtensions ?? Infinity);
}

/**
 * The source of the deadline after a change: the pause's own — except one set exactly to the deadline
 * the pause was made under, which keeps that deadline's source.
 */
function boundOf(pause: PauseRecord, change: PauseTimeoutChange): PauseExpiryBound {
  const { expiryBound } = pause;
  const isBound = change.expiresAt !== undefined && change.expiresAt === pause.boundAt;
  return isBound && expiryBound !== undefined ? expiryBound : PauseExpiryBound.Pause;
}

/**
 * A pending pause's deadline changed (`app.setPauseTimeout`): later, earlier, set or taken away —
 * never to a past time (I3), only from the deadline the caller read and only while the pause is as it
 * was read; `undefined` when it does not apply. The notice names its own change: its `expiresAt` and
 * `previousExpiresAt` each only when there was one, the `actor` and the masked `changeReason`.
 */
export function timeoutChangePlan(
  pause: PauseRecord,
  change: PauseTimeoutChange,
  at: Date,
  recipients: PauseRecipients,
): { readonly pause: PauseRecord; readonly notices: readonly PlannedNotice[] } | undefined {
  if (!isChangeable(pause, change, at)) return undefined;
  return {
    pause: {
      ...pause,
      expiresAt: change.expiresAt,
      expiryBound: boundOf(pause, change),
      remindAt: change.remindAt,
      trail: [...pause.trail, timeoutChangedEntryOf(pause, change, at)],
    },
    notices: noticesOf(recipients, PauseNoticeKind.TimeoutChanged, at, {
      ...(change.expiresAt === undefined ? {} : { expiresAt: change.expiresAt }),
      ...(pause.expiresAt === undefined ? {} : { previousExpiresAt: pause.expiresAt }),
      ...(change.actor === undefined ? {} : { actor: change.actor }),
      ...(change.reason === undefined ? {} : { changeReason: change.reason }),
    }),
  };
}

/** The pause once its channel was asked: `isSent`, and the reference the channel's system gave it, also on its newest entry. */
export function sentPause(pause: PauseRecord, externalRef: string | undefined): PauseRecord {
  if (externalRef === undefined) return { ...pause, isSent: true };
  const last = pause.trail.at(-1);
  return {
    ...pause,
    isSent: true,
    externalRef,
    trail: [...pause.trail.slice(0, -1), ...(last === undefined ? [] : [{ ...last, externalRef }])],
  };
}
