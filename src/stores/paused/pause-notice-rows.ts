import { PauseClosedReason } from "@agboss/core";
import {
  instantOfText,
  PauseNoticeKind,
  type PauseMailbox,
  type PauseNotice,
  type PlannedNotice,
} from "@agboss/core/stores";
import { z } from "zod";
import { changesOf, type Queryable } from "../../connection/query.js";
import { escapedJsonOf, unescapedJson } from "../nul-escape.js";

/**
 * The mailboxes of `PostgresPausedExecutionRepository` (agbossjs/agboss#935): one row per (tenant,
 * pause, recipient) holding its notices in order, the delivered count, the attempts, `next_attempt_at`,
 * `head_written_at` (the head notice's `writtenAt`, kept equal by every append and ack), the claim
 * and `is_dead`. Every statement is atomic on its own row; the append runs in the transaction of the
 * change that causes it (its caller holds the pause's row lock).
 */

/** What the unreadable-time refusal calls a notice. */
const NOTICE = "pause notice";

/** A notice as the JSON keeps it: its times canonical ISO texts, read by `noticeOf`. */
const NoticeRow = z.object({
  seq: z.number(),
  kind: z.enum(PauseNoticeKind),
  writtenAt: z.string(),
  reason: z.enum(PauseClosedReason).optional(),
  closedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  previousExpiresAt: z.string().optional(),
  // `timeout-changed`: who changed the deadline and why, written with the notice so a late delivery names its own change
  actor: z.object({ id: z.string(), orgId: z.string().optional() }).optional(),
  changeReason: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  previousAssignees: z.array(z.string()).optional(),
  previousTarget: z.string().optional(),
  previousChannel: z.string().optional(),
  previousExternalRef: z.string().optional(),
  launch: z.string().optional(),
  errorCode: z.string().optional(),
});

const MailboxRow = z.object({
  tenant_id: z.string(),
  pause_id: z.string(),
  recipient: z.string(),
  notices: z.unknown(),
  delivered: z.number(),
  attempts: z.number(),
  next_attempt_at: z.date(),
  is_dead: z.boolean(),
  problem: z.string().nullable(),
  claim_token: z.string().nullable(),
  claimed_until: z.date().nullable(),
});

/** A mailbox row with its notices read. */
export type StoredMailbox = Omit<z.infer<typeof MailboxRow>, "notices"> & {
  readonly notices: readonly PauseNotice[];
};

/** The time of a notice's text, when it has one: the canonical spelling only, else `StoreError.UnreadableRecord`. */
const instantOf = (text: string | undefined, field: string): Date | undefined =>
  text === undefined ? undefined : instantOfText(text, field, NOTICE);

/** A notice with its times as `Date`s (a text that is no canonical instant is `StoreError.UnreadableRecord`). */
function noticeOf(row: z.infer<typeof NoticeRow>): PauseNotice {
  const { writtenAt, closedAt, expiresAt, previousExpiresAt, ...rest } = row;
  const closed = instantOf(closedAt, "closedAt");
  const expires = instantOf(expiresAt, "expiresAt");
  const previous = instantOf(previousExpiresAt, "previousExpiresAt");
  return {
    ...rest,
    writtenAt: instantOfText(writtenAt, "writtenAt", NOTICE),
    ...(closed === undefined ? {} : { closedAt: closed }),
    ...(expires === undefined ? {} : { expiresAt: expires }),
    ...(previous === undefined ? {} : { previousExpiresAt: previous }),
  };
}

/** The undelivered notices exist: the mailbox waits for delivery (`jsonb_array_length`). */
export const UNDELIVERED = "delivered < jsonb_array_length(notices)";
export const OF_MAILBOX = "tenant_id = $1 AND pause_id = $2 AND recipient = $3";

/** Of the pause alone: a notice of one kind written once is stopped by this pause's, no other's. */
const OF_THIS_PAUSE = "AND n.tenant_id = $1 AND n.pause_id = $2";

/**
 * A mailbox with nothing undelivered takes the appended notice as its head (its last
 * acknowledgement left it none): the head's time, a constant of its own so the mutation shard drops
 * it (agbossjs/agboss#1302). Its attempts and problem need no reset here: that acknowledgement
 * zeroed the one and cleared the other.
 */
const NEW_HEAD = (idle: string): string =>
  `, head_written_at = CASE WHEN ${idle} THEN EXCLUDED.head_written_at
         ELSE agboss_pause_notices.head_written_at END`;

/** A row as read back: its notices' text unescaped, checked. */
export const mailboxRowOf = (row: unknown): StoredMailbox => {
  const parsed = MailboxRow.parse(row);
  const notices = z.array(NoticeRow).parse(unescapedJson(parsed.notices)).map(noticeOf);
  return { ...parsed, notices };
};

/** The mailbox a receiver sees. */
export function mailboxOf(row: StoredMailbox): PauseMailbox {
  const head = row.notices[row.delivered]?.writtenAt;
  return {
    tenantId: row.tenant_id,
    pauseId: row.pause_id,
    recipient: row.recipient,
    notices: row.notices,
    delivered: row.delivered,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(head === undefined ? {} : { headWrittenAt: head }),
    isDead: row.is_dead,
    ...(row.problem === null ? {} : { problem: row.problem }),
  };
}

/** The planned notices of each recipient, numbered from 1, the first one's time the mailbox's head. */
function payloadOf(planned: readonly PlannedNotice[]): string {
  const byRecipient = new Map<string, { readonly at: Date; readonly ones: PlannedNotice[] }>();
  for (const one of planned) {
    const group = byRecipient.get(one.recipient) ?? { at: one.at, ones: [] };
    group.ones.push(one);
    byRecipient.set(one.recipient, group);
  }
  const rows = [...byRecipient].map(([recipient, { at, ones }]) => {
    const notices = escapedJsonOf(ones.map((one, index) => ({ ...one.notice, seq: index + 1 })));
    return `{"recipient":${JSON.stringify(recipient)},"at":${JSON.stringify(at.toISOString())},"notices":${notices}}`;
  });
  return `[${rows.join(",")}]`;
}

/**
 * Appends the planned notices to their mailboxes, one statement (created when absent). The head
 * rule (V3.1): an append to a mailbox with nothing undelivered makes the new notice the head and the
 * mailbox due now; behind an undelivered head neither changes. With `onceKind`, nothing is written
 * when any mailbox of the pause already has a notice of that kind. Returns the mailboxes written.
 */
export function appendNotices(
  database: Queryable,
  tenantId: string,
  pauseId: string,
  planned: readonly PlannedNotice[],
  onceKind?: PauseNoticeKind,
): Promise<number> {
  if (planned.length === 0) return Promise.resolve(0);
  const idle = "agboss_pause_notices.delivered = jsonb_array_length(agboss_pause_notices.notices)";
  return changesOf(
    database,
    `INSERT INTO agboss_pause_notices (tenant_id, pause_id, recipient, notices, delivered, attempts,
       next_attempt_at, head_written_at, is_dead)
     SELECT $1, $2, r.recipient, r.notices, 0, 0, r.at, r.at, false
     FROM jsonb_to_recordset($3::jsonb) AS r(recipient text, at timestamptz, notices jsonb)
     WHERE $4::text IS NULL OR NOT EXISTS (SELECT 1 FROM agboss_pause_notices n
       WHERE n.notices @> jsonb_build_array(jsonb_build_object('kind', $4::text)) ${OF_THIS_PAUSE})
     ON CONFLICT (tenant_id, pause_id, recipient) DO UPDATE SET
       notices = agboss_pause_notices.notices || (SELECT jsonb_agg(e || jsonb_build_object('seq',
         jsonb_array_length(agboss_pause_notices.notices) + o) ORDER BY o)
         FROM jsonb_array_elements(EXCLUDED.notices) WITH ORDINALITY AS t(e, o)),
       next_attempt_at = CASE WHEN ${idle} THEN EXCLUDED.next_attempt_at
         ELSE agboss_pause_notices.next_attempt_at END ${NEW_HEAD(idle)}`,
    [tenantId, pauseId, payloadOf(planned), onceKind ?? null],
  );
}
