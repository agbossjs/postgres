import {
  ApplicationContext,
  ChildExecutionQueueRepository,
  ChildPlacement,
  Clock,
  Injectable,
  Logger,
  LogLevel,
  type ChildExecutionEnd,
  type ChildExecutionQueueWatch,
  type ChildExecutionQueueCounts,
  type QueuedChildExecution,
} from "@agboss/core";
import { listenerOf, PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf, rowsOf } from "../connection/query.js";
import {
  CHILD_QUEUED_CHANNEL,
  CLAIM,
  childOf,
  DEPTH,
  DepthRow,
  SAVE,
} from "./child-queue/child-queue-sql.js";

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
@Injectable({ deps: [PostgresConnection, Clock, ApplicationContext, Logger] })
export class PostgresChildExecutionQueueRepository extends ChildExecutionQueueRepository {
  constructor(
    private readonly connection: PostgresConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly logger: Logger,
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
      child.placement ?? null,
      child.excludeInstanceId ?? null,
    ]);
    return saved === 1;
  }

  /**
   * Wakes `onQueued` whenever any instance queues a child in this schema (agbossjs/agboss#777). A
   * connection that dies silently is noticed within `postgresWatchLivenessSeconds` (agbossjs/agboss#789):
   * a warning (`child-queue.watch-connection-lost`), a new connection and one wake-up.
   */
  override async watchQueued(onQueued: () => void): Promise<ChildExecutionQueueWatch> {
    const listener = await listenerOf(this.connection, {
      channel: CHILD_QUEUED_CHANNEL,
      payload: await this.connection.schema(),
      clock: this.clock,
      warn: (message) => {
        this.logger.write({
          level: LogLevel.Warn,
          code: "child-queue.watch-connection-lost",
          message,
          time: this.clock.now(),
        });
      },
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
      this.applicationContext.instanceId,
    ]);
    return row === undefined ? undefined : childOf(row);
  }

  /** The queued `IsolatedWorker` children, the deepest first, then the longest waiting. */
  async findQueuedIsolatedWorkerChildren(limit: number): Promise<readonly QueuedChildExecution[]> {
    const rows = await rowsOf(
      this.connection.pool,
      `SELECT * FROM agboss_child_execution_queue WHERE status = 'queued' AND placement = $1
       ORDER BY depth DESC, queued_at LIMIT $2`,
      [ChildPlacement.IsolatedWorker, limit],
    );
    return rows.map(childOf);
  }

  /** The targeted claim: one child, `Queued` and `IsolatedWorker`, in one statement. */
  async claimIsolatedWorkerByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined> {
    const row = await firstRowOf(
      this.connection.pool,
      `UPDATE agboss_child_execution_queue SET status = 'running', instance_id = $1, claimed_at = $2
       WHERE tenant_id = $3 AND execution_id = $4 AND status = 'queued' AND placement = $5
       RETURNING *`,
      [
        this.applicationContext.instanceId,
        this.clock.now(),
        tenantId,
        executionId,
        ChildPlacement.IsolatedWorker,
      ],
    );
    return row === undefined ? undefined : childOf(row);
  }

  /** Withdraws a child still `Queued`: a claim and a withdrawal of one row never both win. */
  async withdrawByTenantIdAndExecutionIdIfQueued(
    tenantId: string,
    executionId: string,
  ): Promise<boolean> {
    const removed = await changesOf(
      this.connection.pool,
      `DELETE FROM agboss_child_execution_queue
       WHERE tenant_id = $1 AND execution_id = $2 AND status = 'queued'`,
      [tenantId, executionId],
    );
    return removed === 1;
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
