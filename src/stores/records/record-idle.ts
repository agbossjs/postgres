import type pg from "pg";
import { z } from "zod";
import { changesOf, firstRowOf, rowsOf } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { forgottenStatus } from "../status-log.js";

/**
 * The sweep of idle threads (agbossjs/agboss#1303c) on PostgreSQL: a thread whose memory's `ttl`
 * ran out since its last activity is emptied of its records, summaries, scores, pause answers and
 * status history — never while a tree of it is live or paused. An owned thread stays as a tombstone
 * (`is_swept`): no other owner can take the id; the owner may restart on it. A thread with no owner
 * goes whole. Each thread is decided on its own, in one transaction, so one that came back to life
 * keeps its rows (the check is made again inside the removal, on the locked row).
 */

/** How many threads of one workflow one look removes: the rest go at the next look. */
const THREADS_PER_LOOK = 100;

/** The statuses of a record whose execution may still move: its thread is never removed. */
const LIVE_STATUSES = ["running", "paused", "queued"];

interface IdleThread {
  readonly tenantId: string;
  readonly threadId: string;
}

/** The ids of every run a thread's records name, asked once each. */
export type IsRunEnded = (tree: {
  readonly tenantId: string;
  readonly rootExecutionId: string;
}) => Promise<boolean>;

const ThreadKey = z.object({ tenant_id: z.string(), id: z.string() });
const RunRow = z.object({ run_id: z.string() });

async function idleThreadsOf(
  pool: pg.Pool,
  workflow: string,
  cutoff: Date,
): Promise<readonly IdleThread[]> {
  const rows = await rowsOf(
    pool,
    `SELECT tenant_id, id FROM agboss_threads WHERE workflow = $1 AND NOT is_swept
     AND last_active_at < $2 ORDER BY last_active_at LIMIT $3`,
    [workflow, cutoff, THREADS_PER_LOOK],
  );
  return rows.map((row) => {
    const key = ThreadKey.parse(row);
    return { tenantId: key.tenant_id, threadId: key.id };
  });
}

async function runsOf(pool: pg.Pool, thread: IdleThread): Promise<readonly string[]> {
  const rows = await rowsOf(
    pool,
    `SELECT DISTINCT run_id FROM agboss_execution_records
     WHERE tenant_id = $1 AND thread_id = $2 AND run_id IS NOT NULL`,
    [thread.tenantId, thread.threadId],
  );
  return rows.map((row) => RunRow.parse(row).run_id);
}

/** The thread's rows in every table, children first, in the caller's transaction. */
async function deleteRowsOf(
  client: pg.PoolClient,
  thread: IdleThread,
  runs: readonly string[],
): Promise<void> {
  const { tenantId, threadId } = thread;
  await forgottenStatus(client, thread);
  await changesOf(
    client,
    `DELETE FROM agboss_execution_scores WHERE record_id IN
       (SELECT id FROM agboss_execution_records WHERE tenant_id = $1 AND thread_id = $2)`,
    [tenantId, threadId],
  );
  await changesOf(
    client,
    "DELETE FROM agboss_pause_answers WHERE tenant_id = $1 AND root_execution_id = ANY($2::text[])",
    [tenantId, runs],
  );
  for (const table of ["agboss_execution_summaries", "agboss_execution_records"])
    await changesOf(client, `DELETE FROM ${table} WHERE tenant_id = $1 AND thread_id = $2`, [
      tenantId,
      threadId,
    ]);
  // a thread with an owner stays as a tombstone; one with none goes whole
  const kept = await changesOf(
    client,
    `UPDATE agboss_threads SET is_swept = true
     WHERE tenant_id = $1 AND id = $2 AND owner IS NOT NULL`,
    [tenantId, threadId],
  );
  if (kept === 0)
    await changesOf(client, "DELETE FROM agboss_threads WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      threadId,
    ]);
}

/**
 * Removes the thread in one transaction — only if it is still idle past the cutoff, with no record
 * of a live status and no run beyond `runs` (read on the locked row: a record written since is
 * never lost).
 */
async function removeThread(
  pool: pg.Pool,
  thread: IdleThread,
  options: { readonly workflow: string; readonly cutoff: Date; readonly runs: readonly string[] },
): Promise<boolean> {
  return inPoolTransaction(pool, async (client) => {
    const still = await firstRowOf(
      client,
      `SELECT 1 FROM agboss_threads t WHERE t.tenant_id = $1 AND t.id = $2 AND t.workflow = $3
       AND NOT t.is_swept AND t.last_active_at < $4
       AND NOT EXISTS (SELECT 1 FROM agboss_execution_records x WHERE x.tenant_id = t.tenant_id
         AND x.thread_id = t.id AND x.status = ANY($5::text[]))
       AND NOT EXISTS (SELECT 1 FROM agboss_execution_records y WHERE y.tenant_id = t.tenant_id
         AND y.thread_id = t.id AND y.run_id IS NOT NULL AND y.run_id <> ALL($6::text[]))
       FOR UPDATE OF t`,
      [
        thread.tenantId,
        thread.threadId,
        options.workflow,
        options.cutoff,
        LIVE_STATUSES,
        options.runs,
      ],
    );
    if (still === undefined) return false;
    await deleteRowsOf(client, thread, options.runs);
    return true;
  });
}

/** Whether every run of the thread ended: asked once each; a live or unknown one keeps the thread. */
async function isThreadEnded(
  runs: readonly string[],
  tenantId: string,
  isEnded: IsRunEnded,
): Promise<boolean> {
  for (const runId of runs)
    if (!(await isEnded({ tenantId, rootExecutionId: runId }))) return false;
  return true;
}

/** The sweep of `@Memory({ ttl })`: how many threads went. */
export async function deleteIdleThreads(
  pool: pg.Pool,
  cutoffs: ReadonlyMap<string, Date>,
  isEnded: IsRunEnded,
): Promise<number> {
  let removed = 0;
  for (const [workflow, cutoff] of cutoffs)
    for (const thread of await idleThreadsOf(pool, workflow, cutoff)) {
      const runs = await runsOf(pool, thread);
      if (!(await isThreadEnded(runs, thread.tenantId, isEnded))) continue;
      if (await removeThread(pool, thread, { workflow, cutoff, runs })) removed += 1;
    }
  return removed;
}
