import { PauseStatus, type PauseRecord, type PauseTrailRecord } from "@agboss/core";
import {
  PauseExpiryBound,
  PauseNoticeKind,
  type PauseDeadlineChange,
  type PauseRecipients,
} from "@agboss/core/stores";
import { noticesOf, type PlannedNotice } from "./pause-notice-plan.js";

/**
 * What a deadline change and a send make of a pause (agbossjs/agboss#942, #1099, #1307), restated
 * from the core's pure transitions (`pause-transitions.ts`), which no public entry exports yet.
 */

/** The entry a deadline change adds to the chain of custody: who moved it, when, to what. */
function timeoutChangedEntryOf(
  pause: PauseRecord,
  extension: PauseDeadlineChange,
  at: Date,
): PauseTrailRecord {
  return {
    action: "timeout-changed",
    at: at.toISOString(),
    ...(extension.actor === undefined ? {} : { actor: extension.actor }),
    target: pause.target,
    ...(pause.channel === undefined ? {} : { channel: pause.channel }),
    ...(pause.assignees === undefined ? {} : { assignees: pause.assignees }),
    expiresAt: extension.expiresAt,
    ...(pause.externalRef === undefined ? {} : { externalRef: pause.externalRef }),
  };
}

/**
 * A pending pause's deadline moved: never to a past time (I3), never earlier or equal (#1099), only
 * from the deadline the caller read, and never past `maxExtensions` entries of its chain of custody.
 */
export function extendPlan(
  pause: PauseRecord,
  extension: PauseDeadlineChange,
  at: Date,
  recipients: PauseRecipients,
): { readonly pause: PauseRecord; readonly notices: readonly PlannedNotice[] } | undefined {
  const { expiresAt } = pause;
  if (pause.status !== PauseStatus.Pending || expiresAt === undefined) return undefined;
  if (expiresAt <= at.toISOString()) return undefined;
  if (expiresAt !== extension.previousExpiresAt) return undefined;
  if (![expiresAt, at.toISOString()].every((floor) => extension.expiresAt > floor))
    return undefined;
  const changes = pause.trail.filter((entry) => entry.action === "timeout-changed").length;
  if (extension.maxExtensions !== undefined && changes >= extension.maxExtensions) return undefined;
  return {
    pause: {
      ...pause,
      expiresAt: extension.expiresAt,
      expiryBound: PauseExpiryBound.Pause,
      remindAt: extension.remindAt,
      trail: [...pause.trail, timeoutChangedEntryOf(pause, extension, at)],
    },
    notices: noticesOf(recipients, PauseNoticeKind.Extended, at, {
      expiresAt: extension.expiresAt,
      previousExpiresAt: expiresAt,
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
