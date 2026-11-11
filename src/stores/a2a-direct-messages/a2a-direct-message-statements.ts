import {
  A2ADirectMessageSaveStatus,
  type A2ADirectMessageKey,
  type A2ADirectMessageRecord,
  type A2ADirectMessageSave,
  type A2AMessageRecord,
  type NewA2ADirectMessage,
} from "@agboss/core";
import { DIRECT_MESSAGE_CLAIM, directMessageClaimOf } from "@agboss/core/stores";
import { changesOf, firstRowOf, rowsOf, type Queryable } from "../../connection/query.js";
import {
  MESSAGE_COLUMNS,
  MESSAGE_KEY,
  messageKeyOf,
  messageOf,
} from "../a2a-tasks/a2a-task-rows.js";
import { insertedMessage } from "../a2a-tasks/a2a-task-statements.js";
import { directMessageOf } from "./a2a-direct-message-rows.js";

/**
 * The statements of `PostgresA2ADirectMessageRepository` (agbossjs/agboss#860), on a pool or on
 * `saveIfAbsent`'s and the sweep's transactions.
 */

export async function directMessageAt(
  database: Queryable,
  key: A2ADirectMessageKey,
): Promise<A2ADirectMessageRecord | undefined> {
  const row = await firstRowOf(
    database,
    `SELECT * FROM agboss_a2a_direct_messages WHERE ${MESSAGE_KEY}`,
    messageKeyOf(key),
  );
  return row === undefined ? undefined : directMessageOf(row);
}

/**
 * The claim kept under a message's key, locked `FOR KEY SHARE` until the transaction ends: the
 * sweep, which deletes a claim only once it holds it `FOR UPDATE`, then waits for this transaction
 * and sees the row it saves — a direct message's row is never left without its claim.
 */
async function lockedClaimAt(
  database: Queryable,
  key: A2ADirectMessageKey,
): Promise<A2AMessageRecord | undefined> {
  const row = await firstRowOf(
    database,
    `SELECT ${MESSAGE_COLUMNS} FROM agboss_a2a_messages WHERE ${MESSAGE_KEY} FOR KEY SHARE`,
    messageKeyOf(key),
  );
  return row === undefined ? undefined : messageOf(row);
}

/** Inserts the message's row `InFlight`; `false` when a row is kept under its key already. */
async function insertedDirect(
  database: Queryable,
  message: A2ADirectMessageRecord,
): Promise<boolean> {
  const inserted = await changesOf(
    database,
    `INSERT INTO agboss_a2a_direct_messages (tenant_id, owner_id, message_id, request_hash, skill,
       context_id, state, attempt_id, calls_model, created_at, started_at, expires_at, caller_peer,
       mesh_body_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (tenant_id, owner_id, message_id) DO NOTHING`,
    [
      ...messageKeyOf(message),
      message.requestHash,
      message.skill,
      message.contextId,
      message.state,
      message.attemptId,
      message.callsModel,
      message.createdAt,
      message.startedAt,
      message.expiresAt,
      message.callerPeer ?? null,
      message.meshBodyHash ?? null,
    ],
  );
  return inserted === 1;
}

/** Whether a claim is another message's: a task's, or a direct one of other content. */
const isOthers = (claim: A2AMessageRecord, message: NewA2ADirectMessage): boolean =>
  claim.taskId !== DIRECT_MESSAGE_CLAIM || claim.requestHash !== message.requestHash;

/**
 * One try of `saveIfAbsent`, in its transaction: the claim inserted, or the one kept read and
 * locked; the row kept, or the id another message's; else the row inserted. `undefined` when a row
 * it conflicted with was gone before it was read (the sweep's): try again.
 */
export async function savedDirectOnce(
  database: Queryable,
  message: NewA2ADirectMessage,
  saved: A2ADirectMessageRecord,
): Promise<A2ADirectMessageSave | undefined> {
  const isClaimed = await insertedMessage(database, directMessageClaimOf(message));
  const claim = isClaimed ? undefined : await lockedClaimAt(database, message);
  if (!isClaimed && claim === undefined) return undefined;
  const kept = await directMessageAt(database, message);
  if (kept !== undefined) return { status: A2ADirectMessageSaveStatus.Kept, message: kept };
  if (claim !== undefined && isOthers(claim, message))
    return { status: A2ADirectMessageSaveStatus.Taken };
  if (await insertedDirect(database, saved))
    return { status: A2ADirectMessageSaveStatus.Saved, message: saved };
  // another instance saved the same message under the claim this one holds too
  const winner = await directMessageAt(database, message);
  return winner === undefined
    ? undefined
    : { status: A2ADirectMessageSaveStatus.Kept, message: winner };
}

/**
 * Frees at most `limit` ids the direct messages claimed before `cutoff` whose row is gone (a
 * failed attempt's), oldest first, in the sweep's
 * transaction (bounded work): the claims locked `FOR UPDATE` first — a `saveIfAbsent` holding one is waited for —
 * then deleted by a second statement, whose snapshot sees every row those saves kept.
 */
export async function freedClaims(database: Queryable, cutoff: Date, limit: number): Promise<void> {
  const orphan = `m.task_id = $1 AND m.saved_at < $2 AND NOT EXISTS (
    SELECT 1 FROM agboss_a2a_direct_messages d WHERE d.tenant_id = m.tenant_id
      AND d.owner_id = m.owner_id AND d.message_id = m.message_id)`;
  const locked = await rowsOf(
    database,
    `SELECT ${MESSAGE_COLUMNS} FROM agboss_a2a_messages m WHERE ${orphan}
     ORDER BY m.saved_at, m.tenant_id, m.owner_id, m.message_id LIMIT $3 FOR UPDATE OF m`,
    [DIRECT_MESSAGE_CLAIM, cutoff, limit],
  );
  if (locked.length === 0) return;
  const keys = locked.map(messageOf);
  await changesOf(
    database,
    `DELETE FROM agboss_a2a_messages m
     USING unnest($3::text[], $4::text[], $5::text[]) AS k (tenant_id, owner_id, message_id)
     WHERE m.tenant_id = k.tenant_id AND m.owner_id = k.owner_id AND m.message_id = k.message_id
       AND ${orphan}`,
    [
      DIRECT_MESSAGE_CLAIM,
      cutoff,
      keys.map((key) => key.tenantId),
      keys.map((key) => messageKeyOf(key)[1]),
      keys.map((key) => key.messageId),
    ],
  );
}
