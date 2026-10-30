import {
  ApplicationContext,
  Clock,
  ExecutionLeaseRepository,
  Injectable,
  type ExecutionLease,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";

/**
 * Takes the tree's lease unless another holder's is valid, in one statement: a new key is
 * inserted with epoch 1; an existing row is taken over — epoch + 1 — only when it was released or
 * expired (`expires_at <= now`: valid while `expires_at > now`, as every core store). `RETURNING`
 * gives a row only when this call took the lease.
 */
const ACQUIRE = `INSERT INTO agboss_execution_leases AS lease
    (tenant_id, root_execution_id, holder_instance_id, lease_epoch, expires_at, released)
  VALUES ($1, $2, $3, 1, $4, false)
  ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
    holder_instance_id = EXCLUDED.holder_instance_id,
    lease_epoch = lease.lease_epoch + 1,
    expires_at = EXCLUDED.expires_at,
    released = false
  WHERE lease.released OR lease.expires_at <= $5
  RETURNING lease_epoch`;

/**
 * Extends the caller's own lease: its holder and epoch, not released, not past its end — renewed at
 * the very moment it ends it is kept; a lease already over is not revived (its holder's local
 * fencing has given it up, #335), so a renewal racing another instance's takeover never wins it.
 */
const RENEW = `UPDATE agboss_execution_leases SET expires_at = $1
  WHERE tenant_id = $2 AND root_execution_id = $3 AND holder_instance_id = $4
    AND lease_epoch = $5 AND NOT released AND expires_at >= $6`;

/** Gives the caller's own lease up; another holder's row is not matched. */
const RELEASE = `UPDATE agboss_execution_leases SET released = true
  WHERE tenant_id = $1 AND root_execution_id = $2 AND holder_instance_id = $3
    AND lease_epoch = $4`;

const TakenRow = z.object({ lease_epoch: z.number() });

/**
 * `ExecutionLeaseRepository` on PostgreSQL (#265, #482): one row per tree with its latest lease.
 * Every operation is one statement at `READ COMMITTED` — `acquire` an `INSERT … ON CONFLICT DO
 * UPDATE … WHERE released OR expired`, so of two instances exactly one takes a free lease (the
 * other's conflicting insert waits for the row and finds it held); `renew` and `release` an
 * `UPDATE` matching the holder and the epoch (0 rows: the lease was lost; a renewal also needs
 * the lease not over yet). Times are the
 * framework clock's. Listed in `@Application({ providers })` with `PostgresConnection`'s
 * `postgresUrl`; a lost connection rejects the call, and the core's holder hands the tree over.
 */
@Injectable({ deps: [PostgresConnection, Clock, ApplicationContext] })
export class PostgresExecutionLeaseRepository extends ExecutionLeaseRepository {
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

  async acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + lease);
    const holderInstanceId = this.applicationContext.instanceId;
    const taken = await firstRowOf(this.connection.pool, ACQUIRE, [
      tenantId,
      rootExecutionId,
      holderInstanceId,
      expiresAt,
      now,
    ]);
    if (taken === undefined) return undefined;
    const leaseEpoch = TakenRow.parse(taken).lease_epoch;
    return { tenantId, rootExecutionId, holderInstanceId, leaseEpoch, expiresAt };
  }

  async renew(executionLease: ExecutionLease, lease: Milliseconds): Promise<boolean> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + lease);
    const renewed = await changesOf(this.connection.pool, RENEW, [
      expiresAt,
      executionLease.tenantId,
      executionLease.rootExecutionId,
      executionLease.holderInstanceId,
      executionLease.leaseEpoch,
      now,
    ]);
    return renewed === 1;
  }

  async release(executionLease: ExecutionLease): Promise<void> {
    await changesOf(this.connection.pool, RELEASE, [
      executionLease.tenantId,
      executionLease.rootExecutionId,
      executionLease.holderInstanceId,
      executionLease.leaseEpoch,
    ]);
  }
}
