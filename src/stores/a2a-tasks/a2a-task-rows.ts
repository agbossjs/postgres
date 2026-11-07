import {
  A2ATaskState,
  InvalidA2APageTokenError,
  isTerminalA2ATaskState,
  PauseKind,
  type A2AMessageKey,
  type A2AMessageRecord,
  type A2ATaskRecord,
  type A2ATaskStatus,
} from "@agboss/core";
import { z } from "zod";
import { unescapedJson } from "../nul-escape.js";

/**
 * The rows of `PostgresA2ATaskRepository` (agbossjs/agboss#824): their records, read through zod
 * (rows are never trusted), and the page token of `list`.
 */

export const TERMINAL_STATES: readonly A2ATaskState[] =
  Object.values(A2ATaskState).filter(isTerminalA2ATaskState);

/** No owner is the empty text, which no owner's id is (a key's text, agbossjs/agboss#589). */
export const ownerColumnOf = (ownerId: string | undefined): string => ownerId ?? "";
const ownerOf = (column: string): string | undefined => (column === "" ? undefined : column);

export const MESSAGE_KEY = "tenant_id = $1 AND owner_id = $2 AND message_id = $3";
export const messageKeyOf = (key: A2AMessageKey): readonly [string, string, string] => [
  key.tenantId,
  ownerColumnOf(key.ownerId),
  key.messageId,
];

/**
 * A status as written: a corrupt column is refused, never read as a task's state — and so is a field
 * this store does not know (strict): a status the core grew is never read back without it
 * (agbossjs/agboss#810: a mesh refusal's facts and a completion's spend were dropped so).
 */
const Status = z.strictObject({
  state: z.enum(A2ATaskState),
  message: z.string().optional(),
  pendingPauses: z.array(
    z.object({ pauseId: z.string().optional(), kind: z.enum(PauseKind), ask: z.unknown() }),
  ),
  finish: z.string().optional(),
  output: z.unknown().optional(),
  errorCode: z.string().optional(),
  // agbossjs/agboss#810: a mesh limit's facts (REJECTED), the execution's spend (COMPLETED)
  errorDetails: z.unknown().optional(),
  spentUsd: z.number().nonnegative().optional(),
  cancelRequestedAt: z.iso.datetime().optional(),
});

const TaskRow = z.object({
  tenant_id: z.string(),
  task_id: z.string(),
  owner_id: z.string(),
  context_id: z.string(),
  skill: z.string(),
  state: z.enum(A2ATaskState),
  status: z.unknown(),
  version: z.number().int().positive(),
  accepted_at: z.date(),
  status_at: z.date(),
  caller_peer: z.string().nullable(),
  // agbossjs/agboss#810, migration 0028: none on a task saved before (read as untrusted)
  mesh_body_hash: z.string().nullable(),
});

/** `answered` tells a reply of JSON `null` from a message with none yet (SQL `NULL`). */
const MessageRow = z.object({
  tenant_id: z.string(),
  owner_id: z.string(),
  message_id: z.string(),
  request_hash: z.string(),
  task_id: z.string(),
  saved_at: z.date(),
  reply: z.unknown(),
  answered: z.boolean(),
});

/** The status of a row whose `state` column agrees with it (a compare-and-set reads the column). */
function statusOf(row: z.infer<typeof TaskRow>): A2ATaskStatus {
  const status: A2ATaskStatus = Status.parse(unescapedJson(row.status));
  if (status.state !== row.state)
    throw new Error(
      `agboss_a2a_tasks row ${row.task_id}: its state column and its status disagree`,
    );
  return status;
}

export const taskOf = (row: unknown): A2ATaskRecord => {
  const parsed = TaskRow.parse(row);
  return {
    tenantId: parsed.tenant_id,
    taskId: parsed.task_id,
    ownerId: ownerOf(parsed.owner_id),
    contextId: parsed.context_id,
    skill: parsed.skill,
    status: statusOf(parsed),
    version: parsed.version,
    acceptedAt: parsed.accepted_at,
    statusAt: parsed.status_at,
    ...(parsed.caller_peer === null ? {} : { callerPeer: parsed.caller_peer }),
    ...(parsed.mesh_body_hash === null ? {} : { meshBodyHash: parsed.mesh_body_hash }),
  };
};

export const MESSAGE_COLUMNS =
  "tenant_id, owner_id, message_id, request_hash, task_id, saved_at, reply, reply IS NOT NULL AS answered";

export const messageOf = (row: unknown): A2AMessageRecord => {
  const parsed = MessageRow.parse(row);
  return {
    tenantId: parsed.tenant_id,
    ownerId: ownerOf(parsed.owner_id),
    messageId: parsed.message_id,
    requestHash: parsed.request_hash,
    taskId: parsed.task_id,
    savedAt: parsed.saved_at,
    ...(parsed.answered ? { reply: unescapedJson(parsed.reply) } : {}),
  };
};

const CountRow = z.object({ total: z.coerce.number().int().nonnegative() });

/** The count of a `SELECT count(*) AS total` (bigint: the driver reads it as text). */
export const totalOf = (row: unknown): number => CountRow.parse(row).total;

/** The greatest time a `Date` holds, in ms either side of 1970. */
const MAX_TIME = 8.64e15;

/** A token's content: the status time (one a date holds) and the id of the last task given. */
const PositionToken = z.tuple([z.int().min(-MAX_TIME).max(MAX_TIME), z.string()]);

/** Where a page starts: after this task in the order of `list`. */
export interface PagePosition {
  readonly statusAt: Date;
  readonly taskId: string;
}

/** The opaque token of the page after `task`. */
export const pageTokenOf = (task: Pick<A2ATaskRecord, "statusAt" | "taskId">): string =>
  Buffer.from(JSON.stringify([task.statusAt.getTime(), task.taskId])).toString("base64url");

/** A token's JSON; `undefined` for text that is none, which the token's schema refuses. */
function jsonOf(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Where the page of `token` starts; `InvalidA2APageTokenError` for a token no list gave. */
export function pagePositionOf(token: string): PagePosition {
  const parsed = PositionToken.safeParse(jsonOf(token));
  if (!parsed.success) throw new InvalidA2APageTokenError();
  const [statusAt, taskId] = parsed.data;
  return { statusAt: new Date(statusAt), taskId };
}
