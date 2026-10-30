import {
  ExecutionLeaseEventRepository,
  Injectable,
  type ExecutionLeaseEventRecord,
} from "@agboss/core";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, rowsOf } from "../connection/query.js";
import { leaseEventOf } from "./lease-events/lease-event-rows.js";

/**
 * `ExecutionLeaseEventRepository` on PostgreSQL (#501, #482): the append-only lease log, one row
 * per takeover, hand-over or fenced effect call — its record as `jsonb` beside the columns it is
 * found by. `save` is one `INSERT` (rows are never changed); a tree's rows are read oldest first by
 * `occurred_at`, rows of one moment by their identity `id`, which is the order they were committed
 * in whichever instance saved them. The sweep's `deleteByOccurredAtBefore` is one `DELETE` on the
 * `Clock`'s cutoff, passed as a parameter. Every statement runs alone at `READ COMMITTED`. Listed
 * in `@Application({ providers })` with `postgresUrl`; `app.leaseEventsOf` reads it.
 */
@Injectable({ deps: [PostgresConnection] })
export class PostgresExecutionLeaseEventRepository extends ExecutionLeaseEventRepository {
  constructor(private readonly connection: PostgresConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async save(record: ExecutionLeaseEventRecord): Promise<void> {
    await changesOf(
      this.connection.pool,
      `INSERT INTO agboss_execution_lease_events (tenant_id, root_execution_id, occurred_at, record)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        record.tenantId,
        record.rootExecutionId,
        new Date(record.occurredAt),
        JSON.stringify(record),
      ],
    );
  }

  async findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly ExecutionLeaseEventRecord[]> {
    const rows = await rowsOf(
      this.connection.pool,
      `SELECT record FROM agboss_execution_lease_events
       WHERE tenant_id = $1 AND root_execution_id = $2 ORDER BY occurred_at, id`,
      [tenantId, rootExecutionId],
    );
    return rows.map(leaseEventOf);
  }

  async deleteByOccurredAtBefore(cutoff: Date): Promise<void> {
    await changesOf(
      this.connection.pool,
      "DELETE FROM agboss_execution_lease_events WHERE occurred_at < $1",
      [cutoff],
    );
  }
}
