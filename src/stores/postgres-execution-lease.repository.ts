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
 * gives a row only when this call took the lease, with the row it replaced: `previous` is read and
 * locked first (`MATERIALIZED`, joined into the insert's source so it is evaluated before the
 * upsert changes the row; `FOR UPDATE`, so a concurrent take is waited for and its result read),
 * and an expired — not released — one is the lease's `takenOverFrom` (agbossjs/agboss#501).
 */
const ACQUIRE = `WITH previous AS MATERIALIZED (
    SELECT holder_instance_id, lease_epoch, released FROM agboss_execution_leases
    WHERE tenant_id = $1 AND root_execution_id = $2 FOR UPDATE
  )
  INSERT INTO agboss_execution_leases AS lease
    (tenant_id, root_execution_id, holder_instance_id, lease_epoch, expires_at, released, yielded)
  SELECT $1::text, $2::text, $3::text, 1, $4::timestamptz, false, false
    FROM (SELECT 1) AS one LEFT JOIN previous ON true
  ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
    holder_instance_id = EXCLUDED.holder_instance_id,
    lease_epoch = lease.lease_epoch + 1,
    expires_at = EXCLUDED.expires_at,
    released = false,
    yielded = false
  WHERE lease.released OR lease.expires_at <= $5
  RETURNING lease.lease_epoch,
    (SELECT holder_instance_id FROM previous WHERE NOT released) AS previous_holder,
    (SELECT lease_epoch FROM previous WHERE NOT released) AS previous_epoch`;

/**
 * Extends the caller's own lease: its holder and epoch, not released, not past its end — renewed at
 * the very moment it ends it is kept; a lease already over is not revived (its holder's local
 * fencing has given it up, #335), so a renewal racing another instance's takeover never wins it.
 */
const RENEW = `UPDATE agboss_execution_leases SET expires_at = $1
  WHERE tenant_id = $2 AND root_execution_id = $3 AND holder_instance_id = $4
    AND lease_epoch = $5 AND NOT released AND expires_at >= $6`;

/**
 * Marks the caller's own lease yielded (agbossjs/agboss#516): its holder waits for children on any
 * instance. Matched as `renew` matches it — its holder and epoch, not released, not over — and
 * nothing else changes: `acquire` still finds it valid, `renew` keeps extending it.
 */
const YIELD = `UPDATE agboss_execution_leases SET yielded = true
  WHERE tenant_id = $1 AND root_execution_id = $2 AND holder_instance_id = $3
    AND lease_epoch = $4 AND NOT released AND expires_at >= $5`;

/**
 * The holder takes its own lease back at the next epoch (agbossjs/agboss#516), held again — matched
 * as `renew` matches it, so a lease already over or taken over is not reclaimed.
 */
const RECLAIM = `UPDATE agboss_execution_leases
  SET lease_epoch = lease_epoch + 1, expires_at = $1, yielded = false
  WHERE tenant_id = $2 AND root_execution_id = $3 AND holder_instance_id = $4
    AND lease_epoch = $5 AND NOT released AND expires_at >= $6
  RETURNING lease_epoch`;

/** Gives the caller's own lease up; another holder's row is not matched. */
const RELEASE = `UPDATE agboss_execution_leases SET released = true
  WHERE tenant_id = $1 AND root_execution_id = $2 AND holder_instance_id = $3
    AND lease_epoch = $4`;

/** The key, holder and epoch of `lease`, as the statements above match them. */
const heldBy = (lease: ExecutionLease): readonly [string, string, string, number] => [
  lease.tenantId,
  lease.rootExecutionId,
  lease.holderInstanceId,
  lease.leaseEpoch,
];

const ReclaimedRow = z.object({ lease_epoch: z.number() });

const TakenRow = z.object({
  lease_epoch: z.number(),
  previous_holder: z.string().nullable(),
  previous_epoch: z.number().nullable(),
});

/**
 * `ExecutionLeaseRepository` on PostgreSQL (#265, #482): one row per tree with its latest lease.
 * Every operation is one statement at `READ COMMITTED` — `acquire` an `INSERT … ON CONFLICT DO
 * UPDATE … WHERE released OR expired`, so of two instances exactly one takes a free lease (the
 * other's conflicting insert waits for the row and finds it held); `renew` and `release` an
 * `UPDATE` matching the holder and the epoch (0 rows: the lease was lost; a renewal also needs
 * the lease not over yet), and so are `yield` and `reclaim` (agbossjs/agboss#516: `yielded`, the
 * next epoch). Times are the framework clock's. Listed in `@Application({ providers })` with `PostgresConnection`'s
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
    const row = TakenRow.parse(taken);
    const held = {
      tenantId,
      rootExecutionId,
      holderInstanceId,
      leaseEpoch: row.lease_epoch,
      expiresAt,
    };
    return row.previous_holder === null || row.previous_epoch === null
      ? held
      : {
          ...held,
          takenOverFrom: { holderInstanceId: row.previous_holder, leaseEpoch: row.previous_epoch },
        };
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
    await changesOf(this.connection.pool, RELEASE, heldBy(executionLease));
  }

  async yield(executionLease: ExecutionLease): Promise<boolean> {
    const now = this.clock.now();
    const yielded = await changesOf(this.connection.pool, YIELD, [...heldBy(executionLease), now]);
    return yielded === 1;
  }

  async reclaim(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + lease);
    const reclaimed = await firstRowOf(this.connection.pool, RECLAIM, [
      expiresAt,
      ...heldBy(executionLease),
      now,
    ]);
    if (reclaimed === undefined) return undefined;
    const { tenantId, rootExecutionId, holderInstanceId } = executionLease;
    const { lease_epoch: leaseEpoch } = ReclaimedRow.parse(reclaimed);
    return { tenantId, rootExecutionId, holderInstanceId, leaseEpoch, expiresAt };
  }
}
