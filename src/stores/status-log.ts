import {
  StatusTrigger,
  ThreadStatus,
  type NewStatusTransition,
  type ThreadStatusTransition,
} from "@agboss/core";
import type { StatusContext } from "@agboss/core/stores";
import type { PoolClient } from "pg";
import { z } from "zod";
import { changesOf, firstRowOf, rowsOf } from "../connection/query.js";
import { escapedText, unescapedText } from "./nul-escape.js";

/**
 * The status history of a thread (agbossjs/agboss#1341d) on PostgreSQL: one row of
 * `agboss_thread_status_transitions` per change of the thread's status, written in the very
 * transaction of the change — a lease's mark or a record's status write — so a crash between the
 * change and its row is impossible by construction. The rules that say which write is a change
 * (`transitionOf`, `recordTransitionOf`) are the core's, restated here from its public enums.
 */

interface Thread {
  readonly tenantId: string;
  readonly threadId: string;
}

/**
 * The lock that orders the history's writers of one thread: two transactions of one thread would
 * otherwise read the same last row and both write its next `seq`. A transaction-scoped advisory lock
 * on the thread's identity (a hash collision only orders two threads more). A constant of its own,
 * so the mutation shard drops it.
 */
const LOCK_THREAD = "SELECT pg_advisory_xact_lock(hashtextextended($1, 1341))";

const TransitionRow = z.object({
  tenant_id: z.string(),
  thread_id: z.string(),
  seq: z.number(),
  from_status: z.enum(ThreadStatus).nullable(),
  to_status: z.enum(ThreadStatus),
  trigger: z.enum(StatusTrigger),
  reason: z.string().nullable(),
  actor: z.string().nullable(),
  lease_token: z.number().nullable(),
  at: z.date(),
});

/** A stored row → a transition; the free text of a reason and an actor is read as it was kept. */
export function transitionOfRow(row: unknown): ThreadStatusTransition {
  const r = TransitionRow.parse(row);
  return {
    tenantId: r.tenant_id,
    threadId: r.thread_id,
    seq: r.seq,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    trigger: r.trigger,
    ...(r.reason === null ? {} : { reason: unescapedText(r.reason) }),
    ...(r.actor === null ? {} : { actor: unescapedText(r.actor) }),
    ...(r.lease_token === null ? {} : { leaseToken: r.lease_token }),
    at: r.at,
  };
}

/** The statuses a stop or a cancel under way keeps the thread in while its record moves through `running`. */
const ENDING: readonly (ThreadStatus | undefined)[] = [
  ThreadStatus.Stopping,
  ThreadStatus.Cancelling,
];

/** The reason, actor and lease token of a command's context, those it gave. */
const detailsOf = (context: StatusContext | undefined) => ({
  ...(context?.reason === undefined ? {} : { reason: context.reason }),
  ...(context?.actor === undefined ? {} : { actor: context.actor }),
  ...(context?.leaseToken === undefined ? {} : { leaseToken: context.leaseToken }),
});

/**
 * The row a status change writes, or `undefined` when it changes nothing: a repeated command, or a
 * write that leaves the thread's status as it was, is not a transition; a stop or cancel under way
 * moves its record through `running` while it ends, and the thread is still stopping or cancelling.
 */
export function transitionOf(
  next: NewStatusTransition,
  last: ThreadStatusTransition | undefined,
  at: Date,
): ThreadStatusTransition | undefined {
  if (last?.toStatus === next.toStatus) return undefined;
  if (next.toStatus === ThreadStatus.Running && ENDING.includes(last?.toStatus)) return undefined;
  const { reason, actor, leaseToken, ...base } = next;
  return {
    ...base,
    seq: (last?.seq ?? 0) + 1,
    fromStatus: last?.toStatus ?? null,
    ...detailsOf({ reason, actor, leaseToken }),
    at,
  };
}

/** The thread status each record status makes, and what made it when no command says so. */
const RECORD_STATUS: Readonly<
  Record<string, { readonly status: ThreadStatus; readonly trigger: StatusTrigger } | undefined>
> = {
  running: { status: ThreadStatus.Running, trigger: StatusTrigger.Start },
  paused: { status: ThreadStatus.Paused, trigger: StatusTrigger.Ask },
  answered: { status: ThreadStatus.Finished, trigger: StatusTrigger.Finish },
  guarded: { status: ThreadStatus.Finished, trigger: StatusTrigger.Finish },
  failed: { status: ThreadStatus.Failed, trigger: StatusTrigger.Fail },
  stopped: { status: ThreadStatus.Stopped, trigger: StatusTrigger.Stop },
  cancelled: { status: ThreadStatus.Cancelled, trigger: StatusTrigger.Cancel },
};

/**
 * The transition a record's status write makes, from the statuses alone (a command's context
 * overrides the trigger): `undefined` for a status that is no thread status (`queued`, `written`).
 */
export function recordTransitionOf(
  thread: Thread,
  recordStatus: string,
  last: ThreadStatusTransition | undefined,
  context: StatusContext | undefined,
): NewStatusTransition | undefined {
  const made = RECORD_STATUS[recordStatus];
  if (made === undefined) return undefined;
  return {
    ...thread,
    toStatus: context?.toStatus ?? made.status,
    trigger: context?.trigger ?? triggerOf(made, last),
    ...detailsOf(context),
  };
}

/** What made the change when no command says: a record running again after a pause is a resume. */
function triggerOf(
  made: { readonly status: ThreadStatus; readonly trigger: StatusTrigger },
  last: ThreadStatusTransition | undefined,
): StatusTrigger {
  const wasPaused =
    last?.toStatus === ThreadStatus.Paused || last?.toStatus === ThreadStatus.DualPaused;
  return made.status === ThreadStatus.Running && wasPaused ? StatusTrigger.Resume : made.trigger;
}

/** The thread's last row, read inside the caller's transaction. */
async function lastOf(
  client: PoolClient,
  thread: Thread,
): Promise<ThreadStatusTransition | undefined> {
  const row = await firstRowOf(
    client,
    `SELECT * FROM agboss_thread_status_transitions WHERE tenant_id = $1 AND thread_id = $2
     ORDER BY seq DESC LIMIT 1`,
    [thread.tenantId, thread.threadId],
  );
  return row === undefined ? undefined : transitionOfRow(row);
}

/**
 * Appends `next` to the thread's history in the caller's transaction, unless it changes nothing;
 * the row written, or `undefined`. The thread's writers are ordered by an advisory lock first.
 */
export async function appendStatus(
  client: PoolClient,
  next: NewStatusTransition,
  at: Date,
): Promise<ThreadStatusTransition | undefined> {
  await firstRowOf(client, LOCK_THREAD, [JSON.stringify([next.tenantId, next.threadId])]);
  const written = transitionOf(next, await lastOf(client, next), at);
  if (written === undefined) return undefined;
  await changesOf(
    client,
    `INSERT INTO agboss_thread_status_transitions (tenant_id, thread_id, seq, from_status,
       to_status, trigger, reason, actor, lease_token, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      ...[written.tenantId, written.threadId, written.seq, written.fromStatus],
      ...[written.toStatus, written.trigger],
      written.reason === undefined ? null : escapedText(written.reason),
      written.actor === undefined ? null : escapedText(written.actor),
      written.leaseToken ?? null,
      written.at,
    ],
  );
  return written;
}

/**
 * The status change a write of record status `recordStatus` makes, appended in the write's own
 * transaction: a crash between the status and its row is impossible.
 */
export async function appendRecordStatus(
  client: PoolClient,
  thread: Thread,
  write: {
    readonly status: string;
    readonly context: StatusContext | undefined;
    readonly at: Date;
  },
): Promise<void> {
  await firstRowOf(client, LOCK_THREAD, [JSON.stringify([thread.tenantId, thread.threadId])]);
  const next = recordTransitionOf(
    thread,
    write.status,
    await lastOf(client, thread),
    write.context,
  );
  if (next !== undefined) await appendStatus(client, next, write.at);
}

/** The thread's history, oldest first. */
export async function historyOf(
  client: Pick<PoolClient, "query">,
  thread: Thread,
): Promise<readonly ThreadStatusTransition[]> {
  const rows = await rowsOf(
    client as PoolClient,
    `SELECT * FROM agboss_thread_status_transitions WHERE tenant_id = $1 AND thread_id = $2
     ORDER BY seq`,
    [thread.tenantId, thread.threadId],
  );
  return rows.map(transitionOfRow);
}

/** Removes the thread's rows (its history's keep-time ran out, or its tree was forgotten). */
export async function forgottenStatus(
  database: Pick<PoolClient, "query">,
  thread: Thread,
): Promise<void> {
  await changesOf(
    database as PoolClient,
    "DELETE FROM agboss_thread_status_transitions WHERE tenant_id = $1 AND thread_id = $2",
    [thread.tenantId, thread.threadId],
  );
}
