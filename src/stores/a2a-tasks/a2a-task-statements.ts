import type {
  A2AMessageKey,
  A2AMessageRecord,
  A2ATaskKey,
  A2ATaskRecord,
  NewA2ATask,
} from "@agboss/core";
import { changesOf, firstRowOf, type Queryable } from "../../connection/query.js";
import { escapedJsonOf } from "../nul-escape.js";
import {
  MESSAGE_COLUMNS,
  MESSAGE_KEY,
  messageKeyOf,
  messageOf,
  ownerColumnOf,
  taskOf,
} from "./a2a-task-rows.js";

/** The statements of `PostgresA2ATaskRepository` (agbossjs/agboss#824), on a pool or a transaction. */

/** The fields a new task keeps as they came. */
export const taskFieldsOf = (task: NewA2ATask): Omit<A2ATaskRecord, "version" | "statusAt"> => ({
  tenantId: task.tenantId,
  taskId: task.taskId,
  ownerId: task.ownerId,
  contextId: task.contextId,
  skill: task.skill,
  status: task.status,
  acceptedAt: task.acceptedAt,
  ...(task.callerPeer === undefined ? {} : { callerPeer: task.callerPeer }),
});

export async function insertedMessage(
  database: Queryable,
  message: A2AMessageRecord,
): Promise<boolean> {
  const inserted = await changesOf(
    database,
    `INSERT INTO agboss_a2a_messages
       (tenant_id, owner_id, message_id, request_hash, task_id, saved_at, reply)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (tenant_id, owner_id, message_id) DO NOTHING`,
    [
      ...messageKeyOf(message),
      message.requestHash,
      message.taskId,
      message.savedAt,
      message.reply === undefined ? null : escapedJsonOf(message.reply),
    ],
  );
  return inserted === 1;
}

export async function insertedTask(database: Queryable, task: A2ATaskRecord): Promise<boolean> {
  const inserted = await changesOf(
    database,
    `INSERT INTO agboss_a2a_tasks (tenant_id, task_id, owner_id, context_id, skill, state, status,
       version, accepted_at, status_at, caller_peer)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
     ON CONFLICT (tenant_id, task_id) DO NOTHING`,
    [
      task.tenantId,
      task.taskId,
      ownerColumnOf(task.ownerId),
      task.contextId,
      task.skill,
      task.status.state,
      escapedJsonOf(task.status),
      task.version,
      task.acceptedAt,
      task.statusAt,
      task.callerPeer ?? null,
    ],
  );
  return inserted === 1;
}

export async function taskAt(
  database: Queryable,
  key: A2ATaskKey,
): Promise<A2ATaskRecord | undefined> {
  const row = await firstRowOf(
    database,
    `SELECT * FROM agboss_a2a_tasks WHERE tenant_id = $1 AND task_id = $2`,
    [key.tenantId, key.taskId],
  );
  return row === undefined ? undefined : taskOf(row);
}

export async function messageAt(
  database: Queryable,
  key: A2AMessageKey,
): Promise<A2AMessageRecord | undefined> {
  const row = await firstRowOf(
    database,
    `SELECT ${MESSAGE_COLUMNS} FROM agboss_a2a_messages WHERE ${MESSAGE_KEY}`,
    messageKeyOf(key),
  );
  return row === undefined ? undefined : messageOf(row);
}

/** How often a message whose conflicting row vanished before it was read is inserted again. */
const INSERT_ATTEMPTS = 2;

/**
 * Inserts `message`, or reads the one kept under its key: `undefined` when this call saved it. A
 * conflicting row the retention sweep removed before it was read is inserted again; never
 * `undefined` for a message that is not stored.
 */
export async function savedOrKept(
  database: Queryable,
  message: A2AMessageRecord,
): Promise<A2AMessageRecord | undefined> {
  for (let attempt = 1; attempt <= INSERT_ATTEMPTS; attempt += 1) {
    if (await insertedMessage(database, message)) return undefined;
    const kept = await messageAt(database, message);
    if (kept !== undefined) return kept;
  }
  throw new Error("an A2A message's row conflicted, then was gone, twice: nothing is saved");
}
