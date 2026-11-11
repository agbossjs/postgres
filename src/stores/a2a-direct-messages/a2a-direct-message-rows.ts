import {
  A2ADirectMessageState,
  type A2ADirectMessageRecord,
  type A2ADirectMessageReply,
} from "@agboss/core";
import { z } from "zod";
import { unescapedJson } from "../nul-escape.js";

/**
 * The rows of `PostgresA2ADirectMessageRepository` (agbossjs/agboss#860): their records, read
 * through zod (rows are never trusted), and a page's checked limit.
 */

/**
 * A kept reply as written: a corrupt column is refused, and so is a field this store does not know
 * (strict) — a reply the core grew is never read back without it.
 */
const Reply = z.strictObject({
  finish: z.string(),
  output: z.unknown(),
  spentUsd: z.number().nonnegative(),
});

const DirectRow = z.object({
  tenant_id: z.string(),
  owner_id: z.string(),
  message_id: z.string(),
  request_hash: z.string(),
  skill: z.string(),
  context_id: z.string(),
  state: z.enum(A2ADirectMessageState),
  attempt_id: z.string(),
  calls_model: z.boolean(),
  created_at: z.date(),
  started_at: z.date(),
  expires_at: z.date(),
  caller_peer: z.string().nullable(),
  mesh_body_hash: z.string().nullable(),
  reply: z.unknown(),
  completed_at: z.date().nullable(),
});

type Row = z.infer<typeof DirectRow>;

/** The reply of a row whose state says it has one, and only then: a corrupt row is refused. */
function replyOf(row: Row): Pick<A2ADirectMessageRecord, "reply" | "completedAt"> {
  const hasReply = row.reply !== null;
  const agrees =
    hasReply === (row.completed_at !== null) &&
    hasReply === (row.state === A2ADirectMessageState.Completed);
  if (!agrees)
    throw new Error(
      `agboss_a2a_direct_messages row ${row.message_id}: its state and its reply disagree`,
    );
  if (row.completed_at === null) return {};
  const parsed = Reply.parse(unescapedJson(row.reply));
  const reply: A2ADirectMessageReply = {
    finish: parsed.finish,
    output: parsed.output,
    spentUsd: parsed.spentUsd,
  };
  return { reply, completedAt: row.completed_at };
}

export const directMessageOf = (row: unknown): A2ADirectMessageRecord => {
  const parsed = DirectRow.parse(row);
  return {
    tenantId: parsed.tenant_id,
    ownerId: parsed.owner_id === "" ? undefined : parsed.owner_id,
    messageId: parsed.message_id,
    requestHash: parsed.request_hash,
    skill: parsed.skill,
    contextId: parsed.context_id,
    state: parsed.state,
    attemptId: parsed.attempt_id,
    startedAt: parsed.started_at,
    expiresAt: parsed.expires_at,
    callsModel: parsed.calls_model,
    createdAt: parsed.created_at,
    ...(parsed.caller_peer === null ? {} : { callerPeer: parsed.caller_peer }),
    ...(parsed.mesh_body_hash === null ? {} : { meshBodyHash: parsed.mesh_body_hash }),
    ...replyOf(parsed),
  };
};

/** A page's limit, checked: a whole number from 1, so a sweep's paging always ends. */
export function checkedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(
      `a page of direct A2A messages holds a whole number from 1, not ${String(limit)}`,
    );
  return limit;
}
