import { PauseClosedReason } from "@agboss/core";
import { PauseNoticeKind, type PauseMailbox } from "@agboss/core/stores";
import { z } from "zod";
import { changesOf, type Queryable } from "../../connection/query.js";
import { escapedJsonOf, unescapedJson } from "../nul-escape.js";
import type { PlannedNotice } from "./pause-notice-plan.js";

/**
 * The mailboxes of `PostgresPausedExecutionRepository` (agbossjs/agboss#935): one row per (tenant,
 * pause, recipient) holding its notices in order, the delivered count, the attempts, `next_attempt_at`,
 * `head_written_at` (the head notice's `writtenAt`, kept equal by every append and ack), the claim
 * and `is_dead`. Every statement is atomic on its own row; the append runs in the transaction of the
 * change that causes it (its caller holds the pause's row lock).
 */

const NoticeRow = z.object({
  seq: z.number(),
  kind: z.enum(PauseNoticeKind),
  writtenAt: z.string(),
  reason: z.enum(PauseClosedReason).optional(),
  closedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  previousExpiresAt: z.string().optional(),
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
  readonly notices: readonly z.infer<typeof NoticeRow>[];
};

/** The undelivered notices exist: the mailbox waits for delivery (`jsonb_array_length`). */
export const UNDELIVERED = "delivered < jsonb_array_length(notices)";
export const OF_MAILBOX = "tenant_id = $1 AND pause_id = $2 AND recipient = $3";

/** A row as read back: its notices' text unescaped, checked. */
export const mailboxRowOf = (row: unknown): StoredMailbox => {
  const parsed = MailboxRow.parse(row);
  return { ...parsed, notices: z.array(NoticeRow).parse(unescapedJson(parsed.notices)) };
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
  const byRecipient = new Map<string, PlannedNotice[]>();
  for (const one of planned)
    byRecipient.set(one.recipient, [...(byRecipient.get(one.recipient) ?? []), one]);
  const rows = [...byRecipient].map(([recipient, ones]) => {
    const notices = escapedJsonOf(ones.map((one, index) => ({ ...one.notice, seq: index + 1 })));
    const at = JSON.stringify(ones[0]?.at.toISOString());
    return `{"recipient":${JSON.stringify(recipient)},"at":${at},"notices":${notices}}`;
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
       WHERE n.tenant_id = $1 AND n.pause_id = $2
         AND n.notices @> jsonb_build_array(jsonb_build_object('kind', $4::text)))
     ON CONFLICT (tenant_id, pause_id, recipient) DO UPDATE SET
       notices = agboss_pause_notices.notices || (SELECT jsonb_agg(e || jsonb_build_object('seq',
         jsonb_array_length(agboss_pause_notices.notices) + o) ORDER BY o)
         FROM jsonb_array_elements(EXCLUDED.notices) WITH ORDINALITY AS t(e, o)),
       head_written_at = CASE WHEN ${idle} THEN EXCLUDED.head_written_at
         ELSE agboss_pause_notices.head_written_at END,
       next_attempt_at = CASE WHEN ${idle} THEN EXCLUDED.next_attempt_at
         ELSE agboss_pause_notices.next_attempt_at END,
       attempts = CASE WHEN ${idle} THEN 0 ELSE agboss_pause_notices.attempts END,
       problem = CASE WHEN ${idle} THEN NULL ELSE agboss_pause_notices.problem END`,
    [tenantId, pauseId, payloadOf(planned), onceKind ?? null],
  );
}
