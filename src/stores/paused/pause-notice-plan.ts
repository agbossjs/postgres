import { PauseClosedReason, PauseResolution, PauseStatus, type PauseRecord } from "@agboss/core";
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
  return noticesOf(recipients, PauseNoticeKind.Closed, at, {
    ...(reason === undefined ? {} : { reason }),
    ...(closedAt === undefined ? {} : { closedAt }),
  });
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
  const instant = new Date(text ?? "");
  return Number.isNaN(instant.getTime()) ? new Date(0) : instant;
}

/**
 * The channel was asked (rule 2), the pause as it was read: `opened` to the listeners, then, when
 * the pause closed meanwhile, its `closed` to the channel and the listeners — written at the first
 * close's time (`closedFirst ?? the record`), its reason and time the core's — then its
 * `answerNotTaken` when its answer was closed untaken, at the untaken close's time: what a pause
 * told before its close hears (I8). `markSent` has no `at` and reads no clock.
 */
export function markSentNotices(
  pause: PauseRecord,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const opened = noticesOf(
    recipients,
    PauseNoticeKind.Opened,
    instantOf(pause.askedAt),
    pause.expiresAt === undefined ? {} : { expiresAt: pause.expiresAt },
  );
  if (pause.status === PauseStatus.Pending) return opened;
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
