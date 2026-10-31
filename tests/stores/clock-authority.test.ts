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
import {
  Clock,
  DatabaseStoreClock,
  TestStoreClock,
  type ExecutionLease,
  type StoreClock,
} from "@agboss/core";
import { ClockSkew, SkewedClock } from "@agboss/core/testing";
import type { Milliseconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
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
    time === "database" ? new DatabaseStoreClock(host) : new TestStoreClock(clock);
  return new PostgresExecutionLeaseRepository(
    connectionTo(database.url(), 1),
    storeClock,
    new TestApplicationContext({}, instanceId),
  );
};

/**
 * The first instance takes `root`; the second, skewed, asks while the lease has 300 ms left and
 * again 200 ms after it ended.
 */
async function raced(root: string, skew: ClockSkew, time: Time) {
  const first = storeOf("instance-1", host, time);
  const second = storeOf("instance-2", new SkewedClock(host, skew), time);
  const held = await first.acquire("default", root, LEASE);
  await sleep((LEASE * 5) / 8);
  const whileLive = await second.acquire("default", root, LEASE);
  await sleep((LEASE * 5) / 8);
  const onceOver = whileLive ?? (await second.acquire("default", root, LEASE));
  return { held, whileLive, onceOver };
}

const by = (times: number): Milliseconds => (LEASE * times) as Milliseconds;

const SKEWS: readonly (readonly [string, ClockSkew, "ahead" | "behind" | "drift"])[] = [
  ["half a lease ahead", ClockSkew.ahead(by(0.5)), "ahead"],
  ["half a lease behind", ClockSkew.behind(by(0.5)), "behind"],
  ["a lease ahead", ClockSkew.ahead(by(1)), "ahead"],
  ["a lease behind", ClockSkew.behind(by(1)), "behind"],
  ["10 leases ahead", ClockSkew.ahead(by(10)), "ahead"],
  ["10 leases behind", ClockSkew.behind(by(10)), "behind"],
  ["1 % fast", ClockSkew.drift(0.01), "drift"],
  ["1 % slow", ClockSkew.drift(-0.01), "drift"],
];

const remainingOf = (lease: ExecutionLease | undefined) => lease?.remaining ?? 0;

describe("agbossjs/agboss#533 AC4: the database's clock decides, whatever an instance's clock says", () => {
  it.each(SKEWS)(
    "the other instance's clock %s: no take of a live lease, the take of an expired one on time",
    async (label, skew) => {
      const { held, whileLive, onceOver } = await raced(`root-${label}`, skew, "database");

      expect(remainingOf(held)).toBeGreaterThan(LEASE - 50);
      expect(remainingOf(held)).toBeLessThanOrEqual(LEASE);
      expect(whileLive).toBeUndefined();
      expect(onceOver).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
    },
  );

  it.each(SKEWS.filter(([, , kind]) => kind !== "drift"))(
    "bites: on the caller's clock, the other instance %s breaks it",
    async (label, skew, kind) => {
      const { whileLive, onceOver } = await raced(`caller-${label}`, skew, "caller");

      if (kind === "ahead") expect(whileLive).toBeDefined();
      else expect(onceOver).toBeUndefined();
    },
  );
});
