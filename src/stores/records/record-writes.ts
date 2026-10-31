import { randomUUID } from "node:crypto";
import type { ExecutionRecordStatus } from "@agboss/core";
import { z } from "zod";
import { changesOf, firstRowOf, rowsOf, type Queryable } from "../../connection/query.js";
import { escapedJsonOf, escapedText } from "../nul-escape.js";
import {
  outcomeParameters,
  type NewRecord,
  type NewThreadRecord,
  type PauseAnswer,
  type RecordOutcome,
  type StoredRecord,
} from "./record-rows.js";

/** Threads, appended records, their completion (unconditional or compare-and-set) and the pause log. */

const OwnerRow = z.object({ owner: z.string().nullable() });
const PauseAnswerRow = z.object({ record: z.string() });

/**
 * A new thread: `true` when this insert made it, `false` when the tenant has the id already. A
 * caller's own thread id may be created twice at once: the first insert keeps it (and its owner).
 */
export async function createThread(
  database: Queryable,
  thread: NewThreadRecord,
  id: string,
  now: Date,
): Promise<boolean> {
  const changes = await changesOf(
    database,
    `INSERT INTO agboss_threads (tenant_id, id, workflow, owner, created_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, id) DO NOTHING`,
    [thread.tenantId, id, thread.workflow, thread.ownerId ?? null, now],
  );
  return changes === 1;
}

/** The thread's owner (`owner: undefined`: created without one); `undefined` when there is no such thread. */
export async function threadOwnerOf(
  database: Queryable,
  workflow: string,
  tenantId: string,
  threadId: string,
): Promise<{ readonly owner: string | undefined } | undefined> {
  const row = await firstRowOf(
    database,
    "SELECT owner FROM agboss_threads WHERE tenant_id = $1 AND id = $2 AND workflow = $3",
    [tenantId, threadId, workflow],
  );
  if (row === undefined) return undefined;
  return { owner: OwnerRow.parse(row).owner ?? undefined };
}

/** Appends a record: a new id, the `Clock`'s time; its order is the table's sequence. */
export async function appendRecord(
  database: Queryable,
  record: NewRecord,
  now: Date,
): Promise<StoredRecord> {
  const stored: StoredRecord = { ...record, id: randomUUID(), createdAt: now.toISOString() };
  await changesOf(
    database,
    `INSERT INTO agboss_execution_records (id, run_id, tenant_id, thread_id, workflow, created_at,
       task, reply_with, status, stop_reason, route, steps, cost_usd, prompt_version,
       model_version, replay_of, config_version, config_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16,
       $17, $18)`,
    [
      stored.id,
      stored.runId,
      stored.tenantId,
      stored.threadId,
      stored.bundle,
      now,
      escapedText(stored.task),
      escapedText(stored.replyWith),
      stored.status,
      escapedText(stored.stopReason),
      escapedJsonOf(stored.route),
      escapedJsonOf(stored.steps),
      stored.costUsd,
      stored.promptVersion,
      stored.modelVersion,
      stored.replayOf,
      stored.configVersion,
      stored.configHash,
    ],
  );
  return stored;
}

const COMPLETE = `UPDATE agboss_execution_records SET reply_with = $1, status = $2,
  stop_reason = $3, route = $4::jsonb, steps = $5::jsonb, cost_usd = $6 WHERE id = $7`;

/** Writes the outcome; with `expected`, only while the record's status is it — one statement, atomic. */
export async function completeRecord(
  database: Queryable,
  id: string,
  outcome: RecordOutcome,
  expected?: ExecutionRecordStatus,
): Promise<boolean> {
  const parameters = [...outcomeParameters(outcome), id];
  const changed =
    expected === undefined
      ? await changesOf(database, COMPLETE, parameters)
      : await changesOf(database, `${COMPLETE} AND status = $8`, [...parameters, expected]);
  return changed === 1;
}

/** Keeps a resolved pause once per tenant and step key (a second save is ignored). */
export async function savePauseAnswer(
  database: Queryable,
  tenantId: string,
  rootExecutionId: string,
  answer: PauseAnswer,
): Promise<void> {
  await changesOf(
    database,
    `INSERT INTO agboss_pause_answers (tenant_id, root_execution_id, step_key, asked_at, record)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, step_key) DO NOTHING`,
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
