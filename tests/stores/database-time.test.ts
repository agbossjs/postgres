/**
 * agbossjs/agboss#847 (G7) on #533: in production (`StoreTimeSource.Database`) every lease statement
 * decides by the database's `clock_timestamp()`, never by the host's clock. The store is handed a
 * `StoreClock` whose host clock throws, so a single read of host time for a lease — what a store
 * reading the removed `isDatabaseTime` did silently against the new core — fails the case; the
 * expiry it answers is the database's own time plus the lease.
 */
import { StoreClock, StoreTimeSource } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const LEASE = seconds(30);

/** The production store clock on a host clock that must never be read for a lease. */
const databaseTime = new StoreClock(StoreTimeSource.Database, {
  now: () => {
    throw new Error("a lease decided by the host's clock in StoreTimeSource.Database");
  },
});

const storeOf = (instanceId: string) =>
  new PostgresExecutionLeaseRepository(
    connectionTo(database.url(), 1),
    databaseTime,
    new TestApplicationContext({}, instanceId),
  );

const databaseNow = async (): Promise<number> => {
  const { rows } = await onSchema(database.url(), "SELECT clock_timestamp() AS now");
  return (rows[0] as { now: Date }).now.getTime();
};

describe("#847: in StoreTimeSource.Database a lease is decided by the database's time only", () => {
  it("acquire, renew, yield, reclaim, release and retire never read the host clock", async () => {
    const leases = storeOf("instance-1");
    const before = await databaseNow();
    const lease = await leases.acquire("default", "db-time-1", LEASE);
    const after = await databaseNow();

    // `remaining` reads clock_timestamp() again after `expires_at` was set: a millisecond less at most
    expect(lease?.remaining).toBeGreaterThanOrEqual(LEASE - 1);
    expect(lease?.remaining).toBeLessThanOrEqual(LEASE);
    expect(lease?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + LEASE);
    expect(lease?.expiresAt.getTime()).toBeLessThanOrEqual(after + LEASE);
    if (lease === undefined) return;
    expect(await leases.renew(lease, LEASE)).toBeGreaterThanOrEqual(LEASE - 1);
    expect(await leases.yield(lease)).toBeLessThanOrEqual(LEASE);
    const reclaimed = await leases.reclaim(lease, LEASE);
    expect(reclaimed).toMatchObject({ token: lease.token + 1 });
    if (reclaimed === undefined) return;
    expect(await storeOf("instance-2").acquire("default", "db-time-1", LEASE)).toBeUndefined();
    await leases.release(reclaimed);
    const retiring = await leases.acquire("default", "db-time-2", LEASE);
    if (retiring !== undefined) await leases.retire(retiring);
    expect(retiring).toBeDefined();
    expect(await storeOf("instance-2").acquire("default", "db-time-2", LEASE)).toBeUndefined();
  });
});
