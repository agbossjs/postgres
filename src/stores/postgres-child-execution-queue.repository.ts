import {
  ApplicationContext,
  ChildExecutionQueueRepository,
  Clock,
  ExecutionRecordStatus,
  Injectable,
  type ChildExecutionEnd,
  type ChildExecutionQueueWatch,
  type ChildExecutionQueueCounts,
  type QueuedChildExecution,
} from "@agboss/core";
import { z } from "zod";
import { listenerOf, PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";

/** The channel a save that queues a child notifies (agbossjs/agboss#777). */
const CHILD_QUEUED_CHANNEL = "agboss_child_queued";

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
});

/** A row as the contract gives it back. */
function childOf(row: unknown): QueuedChildExecution {
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
  };
}

/**
 * Queues a child, or queues it again: a paused child (resumed), or a running claim whose worker
 * lost its lease (the caller names that claim's `claimedAt`) — one statement, so of two instances
 * saving one child exactly one gets `true`. A save that queues a child notifies the queue's
 * channel in the same statement (agbossjs/agboss#777), with the stores' schema as its payload:
 * delivered at commit, so a woken instance's claim sees the row.
 */
const SAVE = `WITH saved AS (INSERT INTO agboss_child_execution_queue AS queued (tenant_id, execution_id,
    root_execution_id, parent_execution_id, root_workflow, workflow, depth, status, run, queued_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9)
  ON CONFLICT (tenant_id, execution_id) DO UPDATE SET status = 'queued', run = EXCLUDED.run,
    queued_at = EXCLUDED.queued_at, instance_id = NULL, claimed_at = NULL, ended_at = NULL,
    failure = NULL
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
const CLAIM = `WITH first AS MATERIALIZED (
    SELECT tenant_id, execution_id FROM agboss_child_execution_queue WHERE status = 'queued'
    ORDER BY depth DESC, queued_at LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE agboss_child_execution_queue AS queued
  SET status = 'running', instance_id = $1, claimed_at = $2
  FROM first
  WHERE queued.tenant_id = first.tenant_id AND queued.execution_id = first.execution_id
  RETURNING queued.*`;

/**
 * The queue's depth (agbossjs/agboss#485): one aggregate over the claims index's `status` prefix —
 * the queued and running rows only, at `READ COMMITTED` (a moment of the queue, never a lock).
 */
const DEPTH = `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
    count(*) FILTER (WHERE status = 'running')::int AS running,
    min(queued_at) FILTER (WHERE status = 'queued') AS oldest
  FROM agboss_child_execution_queue WHERE status IN ('queued', 'running')`;

const DepthRow = z.object({ queued: z.number(), running: z.number(), oldest: z.date().nullable() });

/**
 * `ChildExecutionQueueRepository` on PostgreSQL (#333 PR 2, #482): one row per child queued with
 * `ChildPlacement.AnyInstance`. A claim is one `WITH first AS MATERIALIZED (SELECT … FOR UPDATE
 * SKIP LOCKED LIMIT 1) UPDATE … FROM first`, so of two instances exactly one claims a child, a claim
 * marks exactly the child it answers, and neither waits on the other's; a
 * completion is one `UPDATE` matching this instance's running row. Times are the framework
 * clock's. `watchQueued` is a `LISTEN` on the channel every save that queues a child notifies
 * (agbossjs/agboss#777): one connection of its own per instance, beside the pool, idle while
 * nothing is queued; behind a transaction-mode pooler (PgBouncer) notifications do not arrive, and
 * the children are claimed at the sweep. Listed in `@Application({ providers })` with `postgresUrl`.
 */
@Injectable({ deps: [PostgresConnection, Clock, ApplicationContext] })
export class PostgresChildExecutionQueueRepository extends ChildExecutionQueueRepository {
  constructor(
    private readonly connection: PostgresConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async saveIfAbsent(child: QueuedChildExecution): Promise<boolean> {
    const saved = await changesOf(this.connection.pool, SAVE, [
      child.tenantId,
      child.executionId,
      child.rootExecutionId,
      child.parentExecutionId,
      child.rootWorkflow,
      child.workflow,
      child.depth,
      child.run,
      child.queuedAt,
      child.claimedAt ?? null,
    ]);
    return saved === 1;
  }

  /** Wakes `onQueued` whenever any instance queues a child in this schema (agbossjs/agboss#777). */
  override async watchQueued(onQueued: () => void): Promise<ChildExecutionQueueWatch> {
    const listener = await listenerOf(this.connection, {
      channel: CHILD_QUEUED_CHANNEL,
      payload: await this.connection.schema(),
      clock: this.clock,
      onNotify: onQueued,
    });
    return { close: () => listener.close() };
  }

  async findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined> {
    const row = await firstRowOf(
      this.connection.pool,
      "SELECT * FROM agboss_child_execution_queue WHERE tenant_id = $1 AND execution_id = $2",
      [tenantId, executionId],
    );
    return row === undefined ? undefined : childOf(row);
  }

  async claimFirstByStatusQueuedOrderByDepthDesc(): Promise<QueuedChildExecution | undefined> {
    const row = await firstRowOf(this.connection.pool, CLAIM, [
      this.applicationContext.instanceId,
      this.clock.now(),
    ]);
    return row === undefined ? undefined : childOf(row);
  }

  async completeByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
    end: ChildExecutionEnd,
  ): Promise<boolean> {
    const completed = await changesOf(
      this.connection.pool,
      `UPDATE agboss_child_execution_queue SET status = $1, ended_at = $2, failure = $3
       WHERE tenant_id = $4 AND execution_id = $5 AND status = 'running' AND instance_id = $6`,
      [
        end.status,
        this.clock.now(),
        end.failure ?? null,
        tenantId,
        executionId,
        this.applicationContext.instanceId,
      ],
    );
    return completed === 1;
  }

  async deleteAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<void> {
    await changesOf(
      this.connection.pool,
      "DELETE FROM agboss_child_execution_queue WHERE tenant_id = $1 AND root_execution_id = $2",
      [tenantId, rootExecutionId],
    );
  }

  async countByStatus(): Promise<ChildExecutionQueueCounts> {
    const { queued, running, oldest } = DepthRow.parse(
      await firstRowOf(this.connection.pool, DEPTH, []),
    );
    return { queued, running, oldestQueuedAt: oldest ?? undefined };
  }
}
