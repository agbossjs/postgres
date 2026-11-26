import type { PauseNoticeClaim, PauseNoticeCounts, SetAsideMailbox } from "@agboss/core/stores";
import { z } from "zod";
import { changesOf, firstRowOf, rowsOf, type Queryable } from "../../connection/query.js";
import { mailboxOf, mailboxRowOf, OF_MAILBOX, UNDELIVERED } from "./pause-notice-rows.js";

/**
 * The delivery of mailboxes (agbossjs/agboss#935, #910 I9, I10): claimed with `FOR UPDATE SKIP
 * LOCKED` — two instances never claim one mailbox, a locked one is passed over, not waited for — then
 * acknowledged, retried and set aside only for the claim's token.
 */

const SetAsideRow = z.object({
  tenant_id: z.string(),
  pause_id: z.string(),
  recipient: z.string(),
  head_written_at: z.date(),
});
const CountRow = z.object({ live: z.number(), dead: z.number() });
/** What an `UPDATE … RETURNING *` that holds a claim sets: the token and its time. */
const Held = z.object({ claim_token: z.string(), claimed_until: z.date() });

/** The claim a row holds (a statement that just set the claim returned it). */
function heldClaimOf(row: unknown): PauseNoticeClaim {
  const { claim_token: token, claimed_until: until } = Held.parse(row);
  return { mailbox: mailboxOf(mailboxRowOf(row)), token, until };
}

/** The key of a mailbox row, for setting it aside when its notices do not read. */
const MailboxKey = z.object({ tenant_id: z.string(), pause_id: z.string(), recipient: z.string() });

/** The problem a mailbox row that does not read is set aside with. */
export const UNREADABLE_MAILBOX = "unreadable mailbox";

/**
 * The claims of the rows a claim statement returned. A row that does not read (a notice kind no code
 * writes any more, damage) is set aside as dead with its problem — one bad row never fails the claim
 * of the others, as the core's SQLite store does. A row whose key is unreadable too is the statement's
 * failure, never swallowed.
 */
async function readableClaimsOf(
  database: Queryable,
  rows: readonly unknown[],
): Promise<PauseNoticeClaim[]> {
  const claims: PauseNoticeClaim[] = [];
  for (const row of rows) {
    try {
      claims.push(heldClaimOf(row));
    } catch (error) {
      const key = MailboxKey.safeParse(row);
      if (!key.success) throw error;
      await changesOf(
        database,
        `UPDATE agboss_pause_notices SET is_dead = true, problem = $4, claim_token = NULL,
           claimed_until = NULL WHERE ${OF_MAILBOX}`,
        [key.data.tenant_id, key.data.pause_id, key.data.recipient, UNREADABLE_MAILBOX],
      );
    }
  }
  return claims;
}

/**
 * The row lock of a statement that picks mailboxes, and its pass over a row another statement holds
 * (never waited for): two instances pick disjoint mailboxes. Constants of their own, so the
 * mutation shard drops each (agbossjs/agboss#1302).
 */
const SKIP_LOCKED = "SKIP LOCKED";
const ROW_LOCK = `FOR UPDATE ${SKIP_LOCKED}`;

/** A mailbox set aside is never set aside again: its first problem stays. */
const NOT_DEAD = "AND NOT is_dead";

/** Claims up to `limit` due mailboxes of `recipients`, oldest due first, each under a fresh token. */
export async function claimDue(
  database: Queryable,
  at: Date,
  limit: number,
  claimFor: number,
  recipients: readonly string[],
): Promise<readonly PauseNoticeClaim[]> {
  const rows = await rowsOf(
    database,
    `UPDATE agboss_pause_notices SET claim_token = gen_random_uuid()::text, claimed_until = $1
     WHERE (tenant_id, pause_id, recipient) IN (
       SELECT tenant_id, pause_id, recipient FROM agboss_pause_notices
       WHERE NOT is_dead AND ${UNDELIVERED} AND next_attempt_at <= $2
         AND (claimed_until IS NULL OR claimed_until <= $2) AND recipient = ANY($3::text[])
       ORDER BY next_attempt_at LIMIT $4 ${ROW_LOCK})
     RETURNING *`,
    [new Date(at.getTime() + claimFor), at, [...recipients], limit],
  );
  return (await readableClaimsOf(database, rows)).sort(
    (a, b) => a.mailbox.nextAttemptAt.getTime() - b.mailbox.nextAttemptAt.getTime(),
  );
}

/**
 * The head acknowledged — only for the claim's token while its time is not over: the next notice is
 * the head (its `writtenAt` the mailbox's head time) and due at once; the claim stays while notices
 * remain and is released after the last. `undefined` when none remain or the token was lost.
 */
export async function ackHead(
  database: Queryable,
  claim: PauseNoticeClaim,
  at: Date,
): Promise<PauseNoticeClaim | undefined> {
  const { tenantId, pauseId, recipient } = claim.mailbox;
  const row = await firstRowOf(
    database,
    `UPDATE agboss_pause_notices SET delivered = delivered + 1, attempts = 0, next_attempt_at = $4,
       problem = NULL, head_written_at = (notices -> (delivered + 1) ->> 'writtenAt')::timestamptz,
       claim_token = CASE WHEN delivered + 1 < jsonb_array_length(notices) THEN claim_token END,
       claimed_until = CASE WHEN delivered + 1 < jsonb_array_length(notices) THEN claimed_until END
     WHERE ${OF_MAILBOX} AND claim_token = $5 AND claimed_until > $4 RETURNING *`,
    [tenantId, pauseId, recipient, at, claim.token],
  );
  if (row === undefined) return undefined;
  // the last notice's ack released the claim: the token and its time are null together
  const stored = mailboxRowOf(row);
  return stored.claimed_until === null
    ? undefined
    : { mailbox: mailboxOf(stored), token: claim.token, until: stored.claimed_until };
}

/**
 * The claim renewed while its receiver runs (agbossjs/agboss#1131), only for the claim's token and
 * while it holds (`claimed_until > at`; a lapsed claim is never revived): held until `at + claimFor`,
 * never earlier than it was. `undefined` when the token was lost.
 */
export async function renewHead(
  database: Queryable,
  claim: PauseNoticeClaim,
  at: Date,
  claimFor: number,
): Promise<PauseNoticeClaim | undefined> {
  const { tenantId, pauseId, recipient } = claim.mailbox;
  const row = await firstRowOf(
    database,
    `UPDATE agboss_pause_notices SET claimed_until = GREATEST(claimed_until, $4::timestamptz)
     WHERE ${OF_MAILBOX} AND claim_token = $5 AND claimed_until > $6 RETURNING *`,
    [tenantId, pauseId, recipient, new Date(at.getTime() + claimFor), claim.token, at],
  );
  return row === undefined ? undefined : heldClaimOf(row);
}

/** A failed attempt, only for the claim's token: one more, due at `nextAttemptAt`, claim released. */
export async function retryHead(
  database: Queryable,
  claim: PauseNoticeClaim,
  nextAttemptAt: Date,
  problem: string,
): Promise<boolean> {
  const { tenantId, pauseId, recipient } = claim.mailbox;
  const changed = await changesOf(
    database,
    `UPDATE agboss_pause_notices SET attempts = attempts + 1, next_attempt_at = $4, problem = $5,
       claim_token = NULL, claimed_until = NULL WHERE ${OF_MAILBOX} AND claim_token = $6`,
    [tenantId, pauseId, recipient, nextAttemptAt, problem, claim.token],
  );
  return changed === 1;
}

/** The mailbox given up, only for the claim's token: dead, never claimed again. */
export async function setAside(
  database: Queryable,
  claim: PauseNoticeClaim,
  problem: string,
): Promise<boolean> {
  const { tenantId, pauseId, recipient } = claim.mailbox;
  const changed = await changesOf(
    database,
    `UPDATE agboss_pause_notices SET is_dead = true, problem = $4, claim_token = NULL,
       claimed_until = NULL WHERE ${OF_MAILBOX} AND claim_token = $5`,
    [tenantId, pauseId, recipient, problem, claim.token],
  );
  return changed === 1;
}

/**
 * Sets aside, at most `limit`, the live unclaimed mailboxes whose head was written before `before`.
 * A mailbox whose notices were all delivered is none of them without a clause of its own: its last
 * acknowledgement set `head_written_at` to NULL (there is no head), which is never before anything.
 */
export async function setAsideStale(
  database: Queryable,
  before: Date,
  at: Date,
  problem: string,
  limit: number,
): Promise<readonly SetAsideMailbox[]> {
  const rows = await rowsOf(
    database,
    `UPDATE agboss_pause_notices SET is_dead = true, problem = $3, claim_token = NULL,
       claimed_until = NULL
     WHERE (tenant_id, pause_id, recipient) IN (
       SELECT tenant_id, pause_id, recipient FROM agboss_pause_notices
       WHERE head_written_at < $1 AND (claimed_until IS NULL OR claimed_until <= $2) ${NOT_DEAD}
       ORDER BY head_written_at LIMIT $4 ${ROW_LOCK})
     RETURNING tenant_id, pause_id, recipient, head_written_at`,
    [before, at, problem, limit],
  );
  return z
    .array(SetAsideRow)
    .parse(rows)
    .sort((a, b) => a.head_written_at.getTime() - b.head_written_at.getTime())
    .map((row) => ({
      tenantId: row.tenant_id,
      pauseId: row.pause_id,
      recipient: row.recipient,
    }));
}

/** How many mailboxes wait for delivery, how many were set aside. */
export async function countNotices(database: Queryable): Promise<PauseNoticeCounts> {
  const row = await firstRowOf(
    database,
    `SELECT count(*) FILTER (WHERE NOT is_dead AND ${UNDELIVERED})::int AS live,
       count(*) FILTER (WHERE is_dead)::int AS dead FROM agboss_pause_notices`,
  );
  return CountRow.parse(row);
}
