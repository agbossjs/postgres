/**
 * agbossjs/agboss#847 (G7) on #533: in production (`StoreTimeSource.Database`) every lease statement
 * decides by the database's `clock_timestamp()`, never by the host's clock. The store is handed a
 * `StoreClock` whose host clock throws, so a single read of host time for a lease — what a store
 * reading the removed `isDatabaseTime` did silently against the new core — fails the case; the
 * expiry it answers is the database's own time plus the lease.
 *
 * Nothing here compares with the host's wall time, and no bound is a guess about how fast the
 * machine is (agbossjs/agboss#978: a fixed `LEASE - 1` ms broke whenever a statement was descheduled
 * between its `expires_at` and its `remaining`). What a statement answers is bracketed by the
 * database's own clock read before and after it, on two other connections: the time it set the
 * expiry at, and the time it measured `remaining` at, both lie between those two reads, so
 * `remaining` is at least the lease less the bracket's width, and at most the lease. The only
 * constant is `ROUNDING`: each of the three times is a whole number of milliseconds (rounded
 * down), which can move the difference by 1 ms each way.
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

/** The most 1 ms roundings (down, to a whole millisecond) of the database's clock add to a difference. */
const ROUNDING = 2;

const databaseNow = async (): Promise<number> => {
  const { rows } = await onSchema(database.url(), "SELECT clock_timestamp() AS now");
  return (rows[0] as { now: Date }).now.getTime();
};

/** What `call` answered, and the database's time just before it was sent and just after it answered. */
interface Bracketed<T> {
  readonly result: T;
  readonly before: number;
  readonly after: number;
}

async function bracketed<T>(call: () => Promise<T>): Promise<Bracketed<T>> {
  const before = await databaseNow();
  const result = await call();
  return { result, before, after: await databaseNow() };
}

/** `remaining`, from a statement that set the lease's expiry at some time in `set`, measured at some time in `measured`. */
function expectRemaining(
  remaining: number | undefined,
  set: { readonly before: number; readonly after: number },
  measured: { readonly before: number; readonly after: number },
): void {
  expect(remaining).toBeLessThanOrEqual(LEASE);
  // the longest the expiry can have been set before it was measured: from the earliest it was set to the latest it was measured
  expect(remaining).toBeGreaterThanOrEqual(LEASE - (measured.after - set.before) - ROUNDING);
}

describe("#847: in StoreTimeSource.Database a lease is decided by the database's time only", () => {
  it("acquire, renew, yield, reclaim, release and retire never read the host clock", async () => {
    const leases = storeOf("instance-1");
    const before = await databaseNow();
    const lease = await leases.acquire("default", "db-time-1", LEASE);
    const after = await databaseNow();
    const acquired = { before, after };

    // `remaining` reads clock_timestamp() again after `expires_at` was set, however much later the
    // statement was scheduled: the bracket's width bounds it, not a constant
    expectRemaining(lease?.remaining, acquired, acquired);
    expect(lease?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + LEASE);
    expect(lease?.expiresAt.getTime()).toBeLessThanOrEqual(after + LEASE);
    if (lease === undefined) return;
    const renewed = await bracketed(() => leases.renew(lease, LEASE));
    expectRemaining(renewed.result, renewed, renewed);
    // a yield extends nothing: it answers what the renewal's expiry has left, a little later
    const yielded = await bracketed(() => leases.yield(lease));
    expectRemaining(yielded.result, renewed, yielded);
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
