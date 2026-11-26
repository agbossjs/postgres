import {
  PauseClosedReason,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
  type PauseTrailRecord,
} from "@agboss/core";
import {
  closedAtOf,
  pauseClosedReasonOf,
  PauseNoticeKind,
  recipientKeysOf,
  type PauseNotice,
  type PauseNoticeFacts,
  type PauseRecipients,
  type PauseUntakenResolution,
} from "@agboss/core/stores";

/**
 * The notices a change of a pause writes (agbossjs/agboss#935, #910 rules 1–8), planned from the
 * record the change made or read: to whom, when due, and what they say. The store appends them in
 * the transaction of the change; it never decides who listens (`PauseRecipients` says).
 */

/** One notice to write: to whom, and the instant it is due (the transition's `at`). */
export interface PlannedNotice {
  readonly recipient: string;
  readonly at: Date;
  readonly notice: Omit<PauseNotice, "seq">;
}

/** Whether `recipients` hears of any kind of notice. */
export const hasRecipients = (recipients: PauseRecipients): boolean =>
  recipients.channel !== undefined || recipients.listeners.length > 0;

/** The notice of `kind` to each receiver of it, due at `at`. */
export function noticesOf(
  recipients: PauseRecipients,
  kind: PauseNoticeKind,
  at: Date,
  facts: PauseNoticeFacts,
): readonly PlannedNotice[] {
  const notice = { kind, writtenAt: at.toISOString(), ...facts };
  return recipientKeysOf(recipients, kind).map((recipient) => ({ recipient, at, notice }));
}

/** The `closed` notice of a record that is no longer pending. */
export function closedNotices(
  closed: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const reason = pauseClosedReasonOf(closed, at);
  const closedAt = closedAtOf(closed);
  // an undefined fact is no key in the notice's JSON
  return noticesOf(recipients, PauseNoticeKind.Closed, at, { reason, closedAt });
}

/** The `answerNotTaken` notice: why it closed and when. */
export const untakenNotices = (
  resolution: PauseUntakenResolution,
  at: Date,
  recipients: PauseRecipients,
): readonly PlannedNotice[] =>
  noticesOf(recipients, PauseNoticeKind.AnswerNotTaken, at, {
    reason:
      resolution === PauseResolution.Cancelled
        ? PauseClosedReason.Cancelled
        : PauseClosedReason.TreeEnded,
    closedAt: at.toISOString(),
  });

/** The instant of a record's time text; a record stored before `askedAt` (empty) is the epoch. */
function instantOf(text: string | undefined): Date {
  const instant = new Date(String(text)); // no text, like an empty one, is no instant
  return Number.isNaN(instant.getTime()) ? new Date(0) : instant;
}

/**
 * A pause the channel was just sent that was changed in place meanwhile: its `opened` entry (the
 * first of its trail, what the channel was asked with) and the first `reassigned` entry after it. A
 * replacement's own `reassigned` entry is told by `openingNotices`; `undefined` when the pause was
 * not changed in place.
 */
function inPlaceChangeOf(
  pause: PauseRecord,
): { readonly asked: PauseTrailRecord; readonly changed: PauseTrailRecord } | undefined {
  // every pause has its `opened` entry first
  const [asked, ...rest] = pause.trail as [PauseTrailRecord, ...PauseTrailRecord[]];
  const changed = rest.find((entry) => entry.action === "reassigned");
  return pause.reassignedFrom !== undefined || changed === undefined
    ? undefined
    : { asked, changed };
}

/**
 * The notices of a pause whose channel was just asked: `opened` to the listeners — with the deadline
 * the channel was asked with, not one an in-place change set during the send (`inFirstSendNotices`
 * tells that); for a replacement a reassignment made, `reassigned` to the listeners instead (its
 * channel was sent it, the old pause's channel was told `closed`), naming what it moved from — the
 * entry before its own in the chain.
 */
function openingNotices(
  pause: PauseRecord,
  sent: PauseRecord,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const at = instantOf(pause.askedAt);
  if (pause.reassignedFrom === undefined) {
    const asked = inPlaceChangeOf(pause)?.asked ?? pause;
    return noticesOf(recipients, PauseNoticeKind.Opened, at, { expiresAt: asked.expiresAt });
  }
  const before = pause.trail.at(-2);
  return noticesOf({ listeners: recipients.listeners }, PauseNoticeKind.Reassigned, at, {
    expiresAt: pause.expiresAt,
    previousExpiresAt: before?.expiresAt,
    assignees: sent.assignees,
    previousAssignees: before?.assignees,
    previousTarget: before?.target,
    previousChannel: before?.channel,
    previousExternalRef: before?.externalRef,
  });
}

/**
 * The `reassigned` notice of a pause that was changed in place (its trail holds a `reassigned` entry
 * after its own `opened`) while its first send was in flight, to the channel that was just sent it and
 * to the listeners: the in-place change wrote none then (nobody was told of the pause yet). It names
 * what the channel was asked with — the `opened` entry, the first of the trail — and what the pause
 * is now, due at that entry's time. No `previousExternalRef`: a pause not yet sent has no reference.
 */
function inFirstSendNotices(
  sent: PauseRecord,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const change = inPlaceChangeOf(sent);
  if (change === undefined) return [];
  const { asked, changed } = change;
  return noticesOf(recipients, PauseNoticeKind.Reassigned, instantOf(changed.at), {
    expiresAt: sent.expiresAt,
    previousExpiresAt: asked.expiresAt,
    assignees: sent.assignees,
    previousAssignees: asked.assignees,
    previousTarget: asked.target,
    previousChannel: asked.channel,
  });
}

/**
 * The channel was asked (rule 2), the pause as it was read: `opened` to the listeners, then, when
 * it is still `Pending` and was changed in place meanwhile, its `reassigned` (`inFirstSendNotices`),
 * or, when the pause closed meanwhile, its `closed` to the channel and the listeners — written at the first
 * close's time (`closedFirst ?? the record`), its reason and time the core's — then its
 * `answerNotTaken` when its answer was closed untaken, at the untaken close's time: what a pause
 * told before its close hears (I8). `markSent` has no `at` and reads no clock.
 */
export function markSentNotices(
  pause: PauseRecord,
  sent: PauseRecord,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const opened = openingNotices(pause, sent, recipients);
  if (pause.status === PauseStatus.Pending)
    return [...opened, ...inFirstSendNotices(sent, recipients)];
  const closed = closedNotices(
    pause,
    instantOf((pause.closedFirst ?? pause).resolvedAt ?? pause.askedAt),
    recipients,
  );
  const isUntaken =
    pause.answer !== undefined &&
    (pause.resolution === PauseResolution.Cancelled ||
      pause.resolution === PauseResolution.TreeEnded);
  const late = isUntaken
    ? untakenNotices(pause.resolution, instantOf(pause.resolvedAt), recipients)
    : [];
  return [...opened, ...closed, ...late];
}
