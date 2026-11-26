/**
 * agbossjs/agboss#533 AC4 on PostgreSQL, in the process: two instances' lease stores on one
 * database, the second instance's own clock off by ± lease/2, ± lease and ± 10 × lease, or 1 %
 * fast or slow (a `SkewedClock` over the host's — what a per-instance `Date` stub is in one
 * process). In production the store decides by the database's time (`clock_timestamp()` in each
 * statement): the instance ahead never takes a live lease, the one behind takes an expired one on
 * time (the fenced writes' checks on the database's time run in `tests/processes`). It bites: the same store handed the caller's clock as
 * its time (`TestStoreClock(own clock)` — the design before #533, `expires_at` compared with the
 * caller's `now`) gives a live lease to the instance ahead and keeps an expired one from the
 * instance behind.
 */
import { Clock, type ExecutionLease, StoreClock, StoreTimeSource } from "@agboss/core";
import { ClockSkew, SkewedClock } from "@agboss/core/testing";
import type { Milliseconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();

/** The host's clock: real time. */
class HostClock extends Clock {
  now(): Date {
    return new Date();
  }

  sleep(delay: Milliseconds): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
  }
}

const host = new HostClock();
const LEASE = 800 as Milliseconds;
const sleep = (ms: number): Promise<void> => host.sleep(ms as Milliseconds);

/** Whose time the store decides by: the database's (production), or the calling instance's. */
type Time = "database" | "caller";

const storeOf = (instanceId: string, clock: Clock, time: Time) => {
  const storeClock: StoreClock =
    time === "database"
      ? new StoreClock(StoreTimeSource.Database, host)
      : new StoreClock(StoreTimeSource.Test, clock);
  return new PostgresExecutionLeaseRepository(
    connectionTo(database.url(), 1),
    storeClock,
    new TestApplicationContext(instanceId),
  );
};

/** One ask of the second instance, with the time of the clock that decides, read before and after it. */
interface Asked {
  readonly lease: ExecutionLease | undefined;
  readonly before: number;
  readonly after: number;
}

/**
 * Checks `asked` against the clock that decides, whatever the machine did to the schedule
 * (agbossjs/agboss#978): a lease is taken when that clock has reached its expiry, refused before.
 * The test sleeps a lease's fraction on the host and asks; a descheduled process wakes late and the
 * ask lands on the other side of the expiry the test meant it for. So the expected answer is not
 * read off the host's schedule but off the deciding clock, read right before and right after the
 * ask: an ask that ended before the expiry must be refused, one that began at or after it must
 * take; an ask that straddles the expiry (the clock moved past it during the call) may go either
 * way and is not judged. The `1` ms is the whole-millisecond rounding of both times.
 */
function expectDecidedBy(asked: Asked, expiresAt: Date): void {
  const expiry = expiresAt.getTime();
  if (asked.after + 1 <= expiry) expect(asked.lease).toBeUndefined();
  else if (asked.before >= expiry + 1) expect(asked.lease).toBeDefined();
  else expect(asked.after - asked.before).toBeGreaterThanOrEqual(0);
}

const databaseNow = async (): Promise<number> => {
  const { rows } = await onSchema(database.url(), "SELECT clock_timestamp() AS now");
  return (rows[0] as { now: Date }).now.getTime();
};

/**
 * The first instance takes `root`; the second, skewed, asks while the lease has 300 ms left and
 * again 200 ms after it ended — on the host's schedule, which a loaded machine stretches: each ask
 * is judged by the clock that decides (`expectDecidedBy`), not by where it fell on that schedule.
 */
async function raced(root: string, skew: ClockSkew, time: Time) {
  const skewed = new SkewedClock(host, skew);
  const first = storeOf("instance-1", host, time);
  const second = storeOf("instance-2", skewed, time);
  // the clock that decides: the database's (production), or the asking instance's own
  const decidingNow =
    time === "database" ? databaseNow : () => Promise.resolve(skewed.now().getTime());
  const ask = async (): Promise<Asked> => {
    const before = await decidingNow();
    const lease = await second.acquire("default", root, LEASE);
    return { lease, before, after: await decidingNow() };
  };
  const held = await first.acquire("default", root, LEASE);
  await sleep((LEASE * 5) / 8);
  const live = await ask();
  await sleep((LEASE * 5) / 8);
  const over = live.lease === undefined ? await ask() : live;
  return { held, live, over, whileLive: live.lease, onceOver: over.lease };
}

const by = (times: number): Milliseconds => (LEASE * times) as Milliseconds;

const SKEWS: readonly (readonly [string, ClockSkew, "ahead" | "behind" | "drift"])[] = [
  ["half a lease ahead", ClockSkew.ahead(by(0.5)), "ahead"],
  ["half a lease behind", ClockSkew.behind(by(0.5)), "behind"],
  ["a lease ahead", ClockSkew.ahead(by(1)), "ahead"],
  ["a lease behind", ClockSkew.behind(by(1)), "behind"],
  ["10 leases ahead", ClockSkew.ahead(by(10)), "ahead"],
  ["10 leases behind", ClockSkew.behind(by(10)), "behind"],
  ["1 % fast", ClockSkew.drifting(0.01), "drift"],
  ["1 % slow", ClockSkew.drifting(-0.01), "drift"],
];

const remainingOf = (lease: ExecutionLease | undefined) => lease?.remaining ?? 0;

describe("agbossjs/agboss#533 AC4: the database's clock decides, whatever an instance's clock says", () => {
  it.each(SKEWS)(
    "the other instance's clock %s: no take of a live lease, the take of an expired one on time",
    async (label, skew) => {
      const { held, live, over, onceOver } = await raced(`root-${label}`, skew, "database");

      expect(remainingOf(held)).toBeLessThanOrEqual(LEASE);
      // the database's time decides: its own clock, not the host's schedule, says which ask was live
      expect(held?.expiresAt).toBeInstanceOf(Date);
      expectDecidedBy(live, held?.expiresAt ?? new Date(0));
      expectDecidedBy(over, held?.expiresAt ?? new Date(0));
      // whenever the first ask was refused, the second one took it: the lease did expire, on the database's time
      expect(onceOver).toMatchObject({ holderInstanceId: "instance-2", token: 2 });
    },
  );

  it.each(SKEWS.filter(([, , kind]) => kind !== "drift"))(
    "bites: on the caller's clock, the other instance %s breaks it",
    async (label, skew, kind) => {
      const { held, live, over } = await raced(`caller-${label}`, skew, "caller");

      // the caller's own clock decides: the one ahead takes a lease the database still holds live,
      // the one behind does not take an expired one — the answers `expectDecidedBy` reads off it
      expectDecidedBy(live, held?.expiresAt ?? new Date(0));
      expectDecidedBy(over, held?.expiresAt ?? new Date(0));
      // a lateness only strengthens the one ahead: it takes at 500 ms, the lease ended at 800 on its clock + the skew
      if (kind === "ahead") expect(live.lease).toBeDefined();
    },
  );
});
