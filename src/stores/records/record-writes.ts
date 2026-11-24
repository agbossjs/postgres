import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { StatusContext } from "@agboss/core/stores";
import { inPoolTransaction } from "../../connection/transaction.js";
import { appendRecordStatus } from "../status-log.js";
import type {
  ExecutionRecordStatus,
  NewThread,
  NewTurn,
  PauseAnswerRecord,
  Turn,
  TurnOutcome,
} from "@agboss/core";
import { z } from "zod";
import { changesOf, firstRowOf, rowsOf, type Queryable } from "../../connection/query.js";
import { escapedJsonOf, escapedText } from "../nul-escape.js";
import { outcomeParameters } from "./record-rows.js";

/** Threads, appended records, their completion (unconditional or compare-and-set) and the pause log. */

const OwnerRow = z.object({ owner: z.string().nullable(), is_swept: z.boolean() });
const PauseAnswerRow = z.object({ record: z.string() });

/**
 * A new thread: `true` when this insert made it, `false` when the tenant has the id already. A
 * caller's own thread id may be created twice at once: the first insert keeps it (and its owner).
 */
export async function createThread(
  database: Queryable,
  thread: NewThread,
  id: string,
  now: Date,
): Promise<boolean> {
  const changes = await changesOf(
    database,
    `INSERT INTO agboss_threads (tenant_id, id, workflow, owner, created_at, last_active_at)
     VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (tenant_id, id) DO NOTHING`,
    [thread.tenantId, id, thread.workflow, thread.ownerId ?? null, now],
  );
  return changes === 1;
}

/**
 * A caller's own id the tenant already has: kept as it is — except a swept thread (#1303c), fail
 * closed: a different caller, or one naming no owner, is refused; its owner restarts it (the one
 * place the tombstone is cleared).
 */
export async function claimExisting(
  pool: pg.Pool,
  claim: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly ownerId?: string | undefined;
  },
  now: Date,
): Promise<void> {
  await inPoolTransaction(pool, async (client) => {
    const row = await firstRowOf(
      client,
      `SELECT owner, is_swept FROM agboss_threads WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [claim.tenantId, claim.threadId],
    );
    if (row === undefined) return;
    const { owner, is_swept: isSwept } = OwnerRow.parse(row);
    if (!isSwept) return;
    if ((owner ?? undefined) !== claim.ownerId)
      throw new Error("the thread belongs to another owner: it is not created again");
    await changesOf(
      client,
      "UPDATE agboss_threads SET is_swept = false, last_active_at = $3 WHERE tenant_id = $1 AND id = $2",
      [claim.tenantId, claim.threadId, now],
    );
  });
}

/**
 * A caller's own thread id: created, or — the tenant has it already — kept as it is, except a swept
 * one (#1303c), which only its owner restarts.
 */
export async function createOwnThread(
  pool: pg.Pool,
  thread: NewThread,
  id: string,
  now: Date,
): Promise<void> {
  if (await createThread(pool, thread, id, now)) return;
  await claimExisting(
    pool,
    { tenantId: thread.tenantId, threadId: id, ownerId: thread.ownerId },
    now,
  );
}

/** The thread's owner (`owner: undefined`: created without one); `undefined` when there is no such thread. */
export async function threadOwnerOf(
  database: Queryable,
  workflow: string,
  tenantId: string,
  threadId: string,
): Promise<{ readonly owner: string | undefined; readonly isSwept?: true } | undefined> {
  const row = await firstRowOf(
    database,
    `SELECT owner, is_swept FROM agboss_threads WHERE tenant_id = $1 AND id = $2 AND workflow = $3`,
    [tenantId, threadId, workflow],
  );
  if (row === undefined) return undefined;
  const { owner, is_swept: isSwept } = OwnerRow.parse(row);
  // a swept thread is the owner's emptied tombstone: only its owner may restart it
  return { owner: owner ?? undefined, ...(isSwept ? { isSwept: true as const } : {}) };
}

/** A write to a thread's record is its activity: what a memory's `ttl` counts from (#1303). */
const TOUCH = `UPDATE agboss_threads SET last_active_at = $1
  WHERE tenant_id = $2 AND id = $3 AND NOT is_swept`;

/**
 * Appends a record in one transaction with its thread's activity and its status-history row
 * (#1341d): a new id, the `Clock`'s time; its order is the table's sequence. A swept thread (#1303c)
 * takes no record until its owner creates it again.
 */
export async function appendRecord(
  pool: pg.Pool,
  record: NewTurn,
  write: { readonly now: Date; readonly context?: StatusContext | undefined },
): Promise<Turn> {
  const { now } = write;
  const stored: Turn = { ...record, id: randomUUID(), createdAt: now.toISOString() };
  await inPoolTransaction(pool, async (client) => {
    const touched = await changesOf(client, TOUCH, [now, stored.tenantId, stored.threadId]);
    if (touched !== 1)
      throw new Error("the thread was swept: its owner restarts it by creating it again");
    await changesOf(client, INSERT, [
      ...[stored.id, stored.runId, stored.tenantId, stored.threadId, stored.workflow, now],
      ...[escapedText(stored.task), escapedText(stored.replyWith), stored.status],
      ...[escapedText(stored.stopReason), escapedJsonOf(stored.route), escapedJsonOf(stored.steps)],
      ...[stored.costUsd, stored.promptVersion, stored.modelVersion, stored.replayOf],
      ...[stored.configVersion, stored.configHash],
    ]);
    await appendRecordStatus(client, stored, {
      status: stored.status,
      context: write.context,
      at: now,
    });
  });
  return stored;
}

const INSERT = `INSERT INTO agboss_execution_records (id, run_id, tenant_id, thread_id, workflow,
    created_at, task, reply_with, status, stop_reason, route, steps, cost_usd, prompt_version,
    model_version, replay_of, config_version, config_hash)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16,
    $17, $18)`;

const COMPLETE = `UPDATE agboss_execution_records SET reply_with = $1, status = $2,
  stop_reason = $3, route = $4::jsonb, steps = $5::jsonb, cost_usd = $6 WHERE id = $7`;

const ThreadOf = z.object({ tenant_id: z.string(), thread_id: z.string() });

/**
 * Writes the outcome, the thread's activity and its status row in one transaction; with `expected`,
 * only while the record's status is it — one compare-and-set statement, atomic.
 */
export async function completeRecord(
  pool: pg.Pool,
  id: string,
  outcome: TurnOutcome,
  write: {
    readonly now: Date;
    readonly expected?: ExecutionRecordStatus | undefined;
    readonly context?: StatusContext | undefined;
  },
): Promise<boolean> {
  return inPoolTransaction(pool, async (client) => {
    const parameters = [...outcomeParameters(outcome), id];
    const guarded = write.expected === undefined ? "" : " AND status = $8";
    const row = await firstRowOf(
      client,
      `${COMPLETE}${guarded} RETURNING tenant_id, thread_id`,
      write.expected === undefined ? parameters : [...parameters, write.expected],
    );
    if (row === undefined) return false;
    const thread = ThreadOf.parse(row);
    const key = { tenantId: thread.tenant_id, threadId: thread.thread_id };
    await changesOf(client, TOUCH, [write.now, key.tenantId, key.threadId]);
    await appendRecordStatus(client, key, {
      status: outcome.status,
      context: write.context,
      at: write.now,
    });
    return true;
  });
}

/** Keeps a resolved pause once per tenant and step key (a second save is ignored). */
export async function savePauseAnswer(
  database: Queryable,
  tenantId: string,
  rootExecutionId: string,
  answer: PauseAnswerRecord,
): Promise<void> {
  await changesOf(
    database,
    `INSERT INTO agboss_pause_answers (tenant_id, root_execution_id, step_key, asked_at, record)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, root_execution_id, step_key) DO NOTHING`,
    [tenantId, rootExecutionId, answer.step.idempotencyKey, answer.askedAt, JSON.stringify(answer)],
  );
}

/**
 * Keeps that a pause's answer was not taken (I12): over the entry of the same step key, which keeps
 * its `seq` and `asked_at` — its place in the order — or as a new entry; a `savePauseAnswer` after
 * it is ignored, so in either order the entry says *not taken*.
 */
export async function markPauseAnswerNotTaken(
  database: Queryable,
  tenantId: string,
  rootExecutionId: string,
  answer: PauseAnswerRecord,
): Promise<void> {
  await changesOf(
    database,
    `INSERT INTO agboss_pause_answers (tenant_id, root_execution_id, step_key, asked_at, record)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, root_execution_id, step_key)
     DO UPDATE SET record = EXCLUDED.record`,
    [tenantId, rootExecutionId, answer.step.idempotencyKey, answer.askedAt, JSON.stringify(answer)],
  );
}

/** The stored JSON of a tree's resolved pauses, in the order asked (ties in the order kept). */
export async function pauseAnswerTextsOf(
  database: Queryable,
  tenantId: string,
  rootExecutionId: string,
): Promise<readonly string[]> {
  const rows = await rowsOf(
    database,
    `SELECT record FROM agboss_pause_answers WHERE tenant_id = $1 AND root_execution_id = $2
     ORDER BY asked_at, seq`,
    [tenantId, rootExecutionId],
  );
  return rows.map((row) => PauseAnswerRow.parse(row).record);
}
