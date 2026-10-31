import {
  ApplicationContext,
  ExecutionLeaseRepository,
  Injectable,
  StoreClock,
  type ExecutionLease,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";
import { remainingSql, storeNow, storeNowOf } from "./store-time.js";

/**
 * Takes the tree's lease unless another holder's is valid, in one statement: a new key is
 * inserted with epoch 1; an existing row is taken over — epoch + 1 — only when it was released or
 * expired (`expires_at <= now`: valid while `expires_at > now`, as every core store). `RETURNING`
 * gives a row only when this call took the lease, with the row it replaced: `previous` is read and
 * locked first (`MATERIALIZED`, joined into the insert's source so it is evaluated before the
 * upsert changes the row; `FOR UPDATE`, so a concurrent take is waited for and its result read),
 * and an expired — not released — one is the lease's `takenOverFrom` (agbossjs/agboss#501), and so
 * is one an outbound call's check closed as expired (`superseded`, agbossjs/agboss#508). A finished
 * row (agbossjs/agboss#520) is refused by the same `WHERE`: PostgreSQL evaluates it on the row's
 * latest committed version, after waiting for a concurrent `finish`, so no take passes a finish.
 * Its time is the database's (agbossjs/agboss#533, `$5` null; a test's clock otherwise): the new
 * expiry is that time plus the lease (`$4`, ms), and `remaining` what the lease has left by it.
 */
const ACQUIRE = `WITH previous AS MATERIALIZED (
    SELECT holder_instance_id, lease_epoch, NOT released OR superseded AS expired
    FROM agboss_execution_leases
    WHERE tenant_id = $1 AND root_execution_id = $2 FOR UPDATE
  )
  INSERT INTO agboss_execution_leases AS lease
    (tenant_id, root_execution_id, holder_instance_id, lease_epoch, expires_at, released, yielded,
      superseded)
  SELECT $1::text, $2::text, $3::text, 1,
      ${storeNow(5)} + $4::float8 * interval '1 millisecond', false, false, false
    FROM (SELECT 1) AS one LEFT JOIN previous ON true
  ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
    holder_instance_id = EXCLUDED.holder_instance_id,
    lease_epoch = lease.lease_epoch + 1,
    expires_at = EXCLUDED.expires_at,
    released = false,
    yielded = false,
    superseded = false
  WHERE NOT lease.finished AND (lease.released OR lease.expires_at <= ${storeNow(5)})
  RETURNING lease.lease_epoch, lease.expires_at,
    ${remainingSql("lease.expires_at", storeNow(5))} AS remaining,
    (SELECT holder_instance_id FROM previous WHERE expired) AS previous_holder,
    (SELECT lease_epoch FROM previous WHERE expired) AS previous_epoch`;

/**
 * Extends the caller's own lease: its holder and epoch, not released, still live — `expires_at >
 * now`, the one boundary of every lease check (agbossjs/agboss#534): at the very moment it ends it
 * is over for its holder too, so a lease already over is not revived and a renewal racing another
 * instance's takeover never wins it. By the database's time (agbossjs/agboss#533, `$6` null),
 * read after the row's lock; it answers the time the lease has left.
 */
const RENEW = `UPDATE agboss_execution_leases
  SET expires_at = ${storeNow(6)} + $1::float8 * interval '1 millisecond'
  WHERE tenant_id = $2 AND root_execution_id = $3 AND holder_instance_id = $4
    AND lease_epoch = $5 AND NOT released AND expires_at > ${storeNow(6)}
  RETURNING ${remainingSql("expires_at", storeNow(6))} AS remaining`;

/**
 * Marks the caller's own lease yielded (agbossjs/agboss#516): its holder waits for children on any
 * instance. Matched as `renew` matches it — its holder and epoch, not released, not over — and
 * nothing else changes: `acquire` still finds it valid, `renew` keeps extending it.
 */
const YIELD = `UPDATE agboss_execution_leases SET yielded = true
  WHERE tenant_id = $1 AND root_execution_id = $2 AND holder_instance_id = $3
    AND lease_epoch = $4 AND NOT released AND expires_at > ${storeNow(5)}`;

/**
 * The holder takes its own lease back at the next epoch (agbossjs/agboss#516), held again — matched
 * as `renew` matches it, so a lease already over or taken over is not reclaimed.
 */
const RECLAIM = `UPDATE agboss_execution_leases
  SET lease_epoch = lease_epoch + 1, yielded = false,
    expires_at = ${storeNow(6)} + $1::float8 * interval '1 millisecond'
  WHERE tenant_id = $2 AND root_execution_id = $3 AND holder_instance_id = $4
    AND lease_epoch = $5 AND NOT released AND expires_at > ${storeNow(6)}
  RETURNING lease_epoch, expires_at, ${remainingSql("expires_at", storeNow(6))} AS remaining`;

/**
 * Gives the caller's own lease up; another holder's row is not matched. A lease an outbound call's
 * check closed stays `superseded`: its holder releasing it late does not make it a hand-over; a
 * finished one stays `finished` (the column is not written).
 */
const RELEASE = `UPDATE agboss_execution_leases SET released = true
  WHERE tenant_id = $1 AND root_execution_id = $2 AND holder_instance_id = $3
    AND lease_epoch = $4`;

/**
 * Gives the caller's own lease up for good (agbossjs/agboss#520): released and `finished`, so no
 * `acquire` passes it again. Matched as `release` matches — its holder and epoch, also past its end
 * or already released — so a lease another instance took meanwhile (a later epoch) is kept.
 */
const FINISH = `UPDATE agboss_execution_leases SET released = true, finished = true, yielded = false
  WHERE tenant_id = $1 AND root_execution_id = $2 AND holder_instance_id = $3
    AND lease_epoch = $4`;

/** The key, holder and epoch of `lease`, as the statements above match them. */
const heldBy = (lease: ExecutionLease): readonly [string, string, string, number] => [
  lease.tenantId,
  lease.rootExecutionId,
  lease.holderInstanceId,
  lease.leaseEpoch,
];

const ReclaimedRow = z.object({
  lease_epoch: z.number(),
  expires_at: z.date(),
  remaining: z.number(),
});

const RenewedRow = z.object({ remaining: z.number() });

/** A lease's time left as the store answered it (never below 0). */
const remainingOf = (value: number): Milliseconds => Math.max(0, value) as Milliseconds;

const TakenRow = z.object({
  lease_epoch: z.number(),
  expires_at: z.date(),
  remaining: z.number(),
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
 * next epoch), and `finish` (agbossjs/agboss#520: `released` and `finished`, refused by every later
 * `acquire`). Times are the database's (agbossjs/agboss#533: `clock_timestamp()` inside each
 * statement, `StoreClock`; a test's clock when one is injected), and every take and renewal answers
 * the time the lease has left. Listed in `@Application({ providers })` with `PostgresConnection`'s
 * `postgresUrl`; a lost connection rejects the call, and the core's holder hands the tree over.
 */
@Injectable({ deps: [PostgresConnection, StoreClock, ApplicationContext] })
export class PostgresExecutionLeaseRepository extends ExecutionLeaseRepository {
  /** One transactional backend with the other PostgreSQL stores (agbossjs/agboss#526). */
  static override readonly backend: string | undefined = "postgres";
  constructor(
    private readonly connection: PostgresConnection,
    private readonly clock: StoreClock,
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
    const holderInstanceId = this.applicationContext.instanceId;
    const taken = await firstRowOf(this.connection.pool, ACQUIRE, [
      ...[tenantId, rootExecutionId, holderInstanceId, lease],
      storeNowOf(this.clock),
    ]);
    if (taken === undefined) return undefined;
    const row = TakenRow.parse(taken);
    const held = {
      ...{ tenantId, rootExecutionId, holderInstanceId, leaseEpoch: row.lease_epoch },
      ...{ expiresAt: row.expires_at, remaining: remainingOf(row.remaining) },
    };
    return row.previous_holder === null || row.previous_epoch === null
      ? held
      : {
          ...held,
          takenOverFrom: { holderInstanceId: row.previous_holder, leaseEpoch: row.previous_epoch },
        };
  }

  async renew(held: ExecutionLease, lease: Milliseconds): Promise<Milliseconds | undefined> {
    const renewed = await firstRowOf(this.connection.pool, RENEW, [
      ...[lease, held.tenantId, held.rootExecutionId, held.holderInstanceId, held.leaseEpoch],
      storeNowOf(this.clock),
    ]);
    return renewed === undefined ? undefined : remainingOf(RenewedRow.parse(renewed).remaining);
  }

  async release(executionLease: ExecutionLease): Promise<void> {
    await changesOf(this.connection.pool, RELEASE, heldBy(executionLease));
  }

  async finish(executionLease: ExecutionLease): Promise<void> {
    await changesOf(this.connection.pool, FINISH, heldBy(executionLease));
  }

  async yield(executionLease: ExecutionLease): Promise<boolean> {
    const now = storeNowOf(this.clock);
    const yielded = await changesOf(this.connection.pool, YIELD, [...heldBy(executionLease), now]);
    return yielded === 1;
  }

  async reclaim(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const reclaimed = await firstRowOf(this.connection.pool, RECLAIM, [
      ...[lease, ...heldBy(executionLease)],
      storeNowOf(this.clock),
    ]);
    if (reclaimed === undefined) return undefined;
    const { tenantId, rootExecutionId, holderInstanceId } = executionLease;
    const row = ReclaimedRow.parse(reclaimed);
    return {
      ...{ tenantId, rootExecutionId, holderInstanceId, leaseEpoch: row.lease_epoch },
      ...{ expiresAt: row.expires_at, remaining: remainingOf(row.remaining) },
    };
  }
}
