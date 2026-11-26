import {
  isSeenAs,
  narrowedLimits,
  PauseNoticeKind,
  recipientKeysOf,
  replacementPause,
  replacementStepKeyOf,
} from "@agboss/core/stores";
import type {
  PauseInPlaceReassignment,
  PauseLimitsOffer,
  PauseReassignmentChange,
  PauseRecipients,
  PauseReplacement,
} from "@agboss/core/stores";
import type { PauseRecord, PauseTrailRecord } from "@agboss/core";
import { closedNotices, type PlannedNotice } from "./pause-notice-plan.js";
import { countOf, isDueAt, isOpenAt, isWithinCap } from "./pause-open.js";
import { reassignedPause } from "./pause-replacement.js";

/**
 * The plan of a reassignment (agbossjs/agboss#946, #1307): the pause row-locked and read, what the
 * change makes of it, as the core's pure `reassignChange` does (restated: no public entry exports
 * it yet; the replacement record is the core's own `replacementPause`) — the pause as it was seen
 * (`isSeenAs`, `seen` required: a change without one applies to nothing), open at `at` (an
 * expiry's: due), under the limits the RECORD carries, narrowed by the destination of a move; then
 * the pause changed in place, or closed `Reassigned` with its replacement. Planned over the record
 * read under the row lock, so the narrowing is of that read, in the same transaction as the write.
 */

/** What a reassignment writes: the pause as it becomes, its notices, and the replacement it inserts. */
export interface ReassignPlan {
  readonly pause: PauseRecord;
  readonly notices: readonly PlannedNotice[];
  readonly inserted?: PauseRecord;
}

const DEADLINE_KEYS: readonly string[] = ["expiresAt", "expiryBound", "remindAt"];

const isInPlace = (change: PauseReassignmentChange): change is PauseInPlaceReassignment =>
  !("pauseId" in change);

/** What the destination of a move offers of limits; none for a change in place or one that stays. */
const offeredLimitsOf = (change: PauseReassignmentChange): PauseLimitsOffer | undefined =>
  isInPlace(change) ? undefined : change.to?.limits;

/** Whether the change may apply: as seen, open (or due, for an expiry's), under its limits. */
function isApplicable(pause: PauseRecord, change: PauseReassignmentChange, at: Date): boolean {
  if (!isSeenAs(pause, change.seen)) return false;
  if (change.due === undefined ? !isOpenAt(pause, at) : !isDueAt(pause, at)) return false;
  return isUnderLimits(pause, change);
}

/**
 * Whether the change keeps the limits: the record's own, narrowed by the destination of a move —
 * never the change's (those fields are gone) and never the application's present configuration —,
 * the counts and the cap on a deadline the change sets. A limit not named: no count reaches it.
 */
function isUnderLimits(pause: PauseRecord, change: PauseReassignmentChange): boolean {
  const { escalationLimits, maxExpiresAt } = narrowedLimits(pause, offeredLimitsOf(change));
  const deadline = change.due ?? change.timeout;
  if (deadline !== undefined && !isWithinCap(maxExpiresAt, deadline.expiresAt)) return false;
  if (countOf(pause, "reassigned") >= (escalationLimits.maxReassignments ?? Infinity)) return false;
  return !(
    change.countsAsExtension === true &&
    countOf(pause, "timeout-changed") >= (escalationLimits.maxExtensions ?? Infinity)
  );
}

/** The recipients of the old pause's `closed`: its channel only — listeners hear `reassigned`. */
const channelOnly = (recipients: PauseRecipients): PauseRecipients => ({
  ...(recipients.channel === undefined ? {} : { channel: recipients.channel }),
  listeners: [],
});

/** The entry an in-place reassignment adds to the chain of custody. */
function inPlaceEntryOf(
  pause: PauseRecord,
  change: PauseInPlaceReassignment,
  expiresAt: string | undefined,
  at: Date,
): PauseTrailRecord {
  const { assignees, actor, reason } = change;
  return {
    action: "reassigned",
    at: at.toISOString(),
    ...(actor === undefined ? {} : { actor }),
    target: pause.target,
    ...(pause.channel === undefined ? {} : { channel: pause.channel }),
    ...(assignees === undefined ? {} : { assignees }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(pause.externalRef === undefined ? {} : { externalRef: pause.externalRef }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The pause as an in-place reassignment leaves it. */
function reassignedInPlace(
  pause: PauseRecord,
  change: PauseInPlaceReassignment,
  at: Date,
): PauseRecord {
  const deadline = change.due ?? change.timeout;
  const expiresAt = deadline === undefined ? pause.expiresAt : deadline.expiresAt;
  const dropped = ["assignees", ...(deadline === undefined ? [] : DEADLINE_KEYS)];
  const entry = inPlaceEntryOf(pause, change, expiresAt, at);
  return {
    ...(Object.fromEntries(
      Object.entries(pause).filter(([key]) => !dropped.includes(key)),
    ) as PauseRecord),
    ...deadline,
    ...(change.assignees === undefined ? {} : { assignees: change.assignees }),
    trail: [
      ...pause.trail,
      entry,
      ...(change.countsAsExtension === true
        ? [{ ...entry, action: "timeout-changed" as const }]
        : []),
    ],
  };
}

/** The `reassigned` notice of an in-place change, to the channel that sent the pause and the listeners. */
function inPlaceNotices(
  before: PauseRecord,
  after: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  if (!before.isSent) return [];
  const notice = {
    kind: PauseNoticeKind.Reassigned,
    writtenAt: at.toISOString(),
    ...(after.expiresAt === undefined ? {} : { expiresAt: after.expiresAt }),
    ...(before.expiresAt === undefined ? {} : { previousExpiresAt: before.expiresAt }),
    ...(after.assignees === undefined ? {} : { assignees: after.assignees }),
    ...(before.assignees === undefined ? {} : { previousAssignees: before.assignees }),
    previousTarget: before.target,
    ...(before.channel === undefined ? {} : { previousChannel: before.channel }),
    ...(before.externalRef === undefined ? {} : { previousExternalRef: before.externalRef }),
  };
  return recipientKeysOf(recipients, PauseNoticeKind.Reassigned).map((recipient) => ({
    recipient,
    at,
    notice,
  }));
}

/** The replacement: the old pause closed `Reassigned` (its `closed` to its channel), the new one inserted unsent. */
function replacementPlan(
  pause: PauseRecord,
  replacement: PauseReplacement,
  takenStepKeys: ReadonlySet<string>,
  at: Date,
  recipients: PauseRecipients,
): ReassignPlan {
  const stepKey = replacementStepKeyOf(pause, takenStepKeys);
  const closed = reassignedPause(pause, replacement.pauseId, at);
  return {
    pause: closed,
    notices: pause.isSent ? closedNotices(closed, at, channelOnly(recipients)) : [],
    inserted: replacementPause(pause, { ...replacement, stepKey }, at),
  };
}

/** What the reassignment makes of `pause`; `undefined` when it does not apply. */
export function reassignPlan(
  pause: PauseRecord,
  change: PauseReassignmentChange,
  takenStepKeys: ReadonlySet<string>,
  at: Date,
  recipients: PauseRecipients,
): ReassignPlan | undefined {
  if (!isApplicable(pause, change, at)) return undefined;
  if (!isInPlace(change)) return replacementPlan(pause, change, takenStepKeys, at, recipients);
  const after = reassignedInPlace(pause, change, at);
  return { pause: after, notices: inPlaceNotices(pause, after, at, recipients) };
}
