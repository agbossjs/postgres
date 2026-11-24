import { ChildPlacement, ExecutionRecordStatus, type QueuedChildExecution } from "@agboss/core";
import { z } from "zod";

/** The rows and statements of `PostgresChildExecutionQueueRepository`. */

/** The channel a save that queues a child notifies (agbossjs/agboss#777). */
export const CHILD_QUEUED_CHANNEL = "agboss_child_queued";

const QueueRow = z.object({
  tenant_id: z.string(),
  execution_id: z.string(),
  root_execution_id: z.string(),
  parent_execution_id: z.string(),
  root_workflow: z.string(),
  workflow: z.string(),
  depth: z.number(),
  status: z.enum(ExecutionRecordStatus),
  run: z.string(),
  queued_at: z.date(),
  instance_id: z.string().nullable(),
  claimed_at: z.date().nullable(),
  ended_at: z.date().nullable(),
  failure: z.string().nullable(),
  placement: z.enum(ChildPlacement).nullable(),
  exclude_instance_id: z.string().nullable(),
});

/** A row as the contract gives it back. */
export function childOf(row: unknown): QueuedChildExecution {
  const r = QueueRow.parse(row);
  return {
    tenantId: r.tenant_id,
    executionId: r.execution_id,
    rootExecutionId: r.root_execution_id,
    parentExecutionId: r.parent_execution_id,
    rootWorkflow: r.root_workflow,
    workflow: r.workflow,
    depth: r.depth,
    status: r.status,
    run: r.run,
    queuedAt: r.queued_at,
    instanceId: r.instance_id ?? undefined,
    claimedAt: r.claimed_at ?? undefined,
    endedAt: r.ended_at ?? undefined,
    failure: r.failure ?? undefined,
    placement: r.placement ?? undefined,
    excludeInstanceId: r.exclude_instance_id ?? undefined,
  };
}

/**
 * What a child queued again keeps of its last run: nothing (no claim, no end, no failure). A
 * constant of its own, so the mutation shard drops it (agbossjs/agboss#1302).
 */
const CLEARED = ", claimed_at = NULL, ended_at = NULL, failure = NULL";

/**
 * The claim's row lock, and its pass over a row another claimer holds locked (never waited for);
 * the claim marks the child of the tenant it chose. Constants of their own, so the mutation shard
 * drops each (agbossjs/agboss#1302).
 */
const SKIP_LOCKED = "SKIP LOCKED";
const ROW_LOCK = `FOR UPDATE ${SKIP_LOCKED}`;
/**
 * What a general claim skips (#1286): an `IsolatedWorker` row (its own process claims it) and a row
 * this instance queued itself for `OtherWorker` (`$3`). A constant of its own, so the mutation shard
 * drops it.
 */
const GENERAL = `AND (placement IS NULL OR placement <> 'isolated-worker')
      AND (exclude_instance_id IS NULL OR exclude_instance_id <> $3)`;
const OF_TENANT = "AND queued.tenant_id = first.tenant_id";

/**
 * Queues a child, or queues it again: a paused child (resumed), or a running claim whose worker
 * lost its lease (the caller names that claim's `claimedAt`) — one statement, so of two instances
 * saving one child exactly one gets `true`. A save that queues a child notifies the queue's
 * channel in the same statement (agbossjs/agboss#777), with the stores' schema as its payload:
 * delivered at commit, so a woken instance's claim sees the row.
 */
export const SAVE = `WITH saved AS (INSERT INTO agboss_child_execution_queue AS queued (tenant_id, execution_id,
    root_execution_id, parent_execution_id, root_workflow, workflow, depth, status, run, queued_at,
    placement, exclude_instance_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $11, $12)
  ON CONFLICT (tenant_id, execution_id) DO UPDATE SET status = 'queued', run = EXCLUDED.run,
    queued_at = EXCLUDED.queued_at, instance_id = NULL ${CLEARED},
    placement = EXCLUDED.placement, exclude_instance_id = EXCLUDED.exclude_instance_id
  WHERE queued.status = 'paused' OR (queued.status = 'running' AND queued.claimed_at = $10)
  RETURNING 1)
  SELECT pg_notify('${CHILD_QUEUED_CHANNEL}', current_schema()) FROM saved`;

/**
 * Claims the first queued child — the deepest, then the longest waiting — in one statement: the
 * row is locked with `FOR UPDATE SKIP LOCKED` (a row another instance is claiming is passed over,
 * never waited for) and marked running for this instance. The choice is a `MATERIALIZED` CTE, run
 * once (agbossjs/agboss#720): as a subquery joined to the table, a plan made on statistics of a
 * nearly empty queue rescanned it once per row of the table — each rescan skipped the rows the
 * statement had already marked and locked the next — so one claim marked many children `running`
 * and answered one; the others ran nowhere.
 */
export const CLAIM = `WITH first AS MATERIALIZED (
    SELECT tenant_id, execution_id FROM agboss_child_execution_queue WHERE status = 'queued'
      ${GENERAL}
    ORDER BY depth DESC, queued_at LIMIT 1 ${ROW_LOCK}
  )
  UPDATE agboss_child_execution_queue AS queued
  SET status = 'running', instance_id = $1, claimed_at = $2
  FROM first
  WHERE queued.execution_id = first.execution_id ${OF_TENANT}
  RETURNING queued.*`;

/**
 * The queue's depth (agbossjs/agboss#485): one aggregate over the claims index's `status` prefix —
 * the queued and running rows only, at `READ COMMITTED` (a moment of the queue, never a lock).
 */
export const DEPTH = `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
    count(*) FILTER (WHERE status = 'running')::int AS running,
    min(queued_at) FILTER (WHERE status = 'queued') AS oldest
  FROM agboss_child_execution_queue WHERE status IN ('queued', 'running')`;

export const DepthRow = z.object({
  queued: z.number(),
  running: z.number(),
  oldest: z.date().nullable(),
});
