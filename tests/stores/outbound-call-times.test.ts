/**
 * agbossjs/agboss#658 on PostgreSQL, in the process: what a `reconcile` is told of a pending
 * attempt — when it started (`attemptStartedAt`) and when the store read it (`readAt`, which a key's
 * age is measured to) — is the database's time in production (`clock_timestamp()`, read by the
 * fence after it locked the lease row), whatever the instance's clock says: two instances, one two
 * days ahead and one two days behind, read the same times, close to the database's own. It bites:
 * the same store handed the caller's clock as its time (`TestStoreClock`) writes the skewed time.
 */
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import {
  Clock,
  DatabaseStoreClock,
  type ExecutionLease,
  type EffectKey,
  type StoreClock,
} from "@agboss/core";
import { ClockSkew, SkewedClock, TestStoreClock } from "@agboss/core/testing";
import { hours, seconds, type Milliseconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresOutboundCallRepository,
} from "../../src/index.js";
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
const TWO_DAYS = hours(48);

/** Whose time the store decides by: the database's (production), or the calling instance's. */
type Time = "database" | "caller";

function instanceOn(clock: Clock, time: Time, index: number) {
  const storeClock: StoreClock =
    time === "database" ? new DatabaseStoreClock(clock) : new TestStoreClock(clock);
  const connection = connectionTo(database.url(), 1);
  return {
    calls: new PostgresOutboundCallRepository(connection, storeClock),
    leases: new PostgresExecutionLeaseRepository(
      connection,
      storeClock,
      new TestApplicationContext({}, `instance-${String(index)}`),
    ),
  };
}

const keyOf = (lease: ExecutionLease): EffectKey =>
  effectKeyForTesting({
    scopeKey: `${lease.tenantId}:${lease.rootExecutionId}`,
    tenantId: lease.tenantId,
    leaseExecutionId: lease.rootExecutionId,
    token: lease.leaseEpoch,
    idempotencyKey: `${lease.rootExecutionId}:charge-action:1`,
    name: "charge",
  });

/** The database's own time now. */
async function databaseNow(): Promise<number> {
  const { rows } = await onSchema(database.url(), "SELECT clock_timestamp() AS now");
  const [row] = rows;
  return (row as { now: Date }).now.getTime();
}

/** An intent saved by the instance ahead, read by the one behind: the times each read gives. */
async function timesOf(root: string, time: Time) {
  const ahead = instanceOn(new SkewedClock(host, ClockSkew.ahead(TWO_DAYS)), time, 1);
  const behind = instanceOn(new SkewedClock(host, ClockSkew.behind(TWO_DAYS)), time, 2);
  const lease = await ahead.leases.acquire("default", root, hours(72));
  if (lease === undefined) throw new Error(`the lease of ${root} is held`);
  const key = keyOf(lease);
  const before = await databaseNow();
  await ahead.calls.saveIfAbsent(key, {
    rootExecutionId: root,
    executionId: root,
    workflow: "charge-workflow",
    target: "payments",
    operation: "charge",
    idempotencyKey: `${key.idempotencyKey}:charge`,
    request: "{}",
    attempt: 1,
    attemptOwner: "owner-1",
    step: { nodeId: "charge-action", visitNumber: 1 },
  });
  const read = await behind.calls.findByKey(key);
  const after = await databaseNow();
  const at = (text: string | undefined): number => Date.parse(text ?? "");
  return {
    before,
    after,
    started: at(read?.attemptStartedAt),
    first: at(read?.firstAttemptStartedAt),
    readAt: at(read?.readAt),
    recordedAt: at(read?.recordedAt),
  };
}

describe("#658 on PostgreSQL: an attempt's start and its read are the database's time", () => {
  it("instances two days ahead and behind write and read the database's time; recordedAt stays the writer's clock", async () => {
    const times = await timesOf("execution-db", "database");

    // the database's time, to its milliseconds (a timestamp is read to the millisecond)
    expect(times.started).toBeGreaterThanOrEqual(times.before - 1);
    expect(times.readAt).toBeLessThanOrEqual(times.after);
    expect(times.first).toBe(times.started);
    expect(times.readAt).toBeGreaterThanOrEqual(times.started);
    expect(times.recordedAt - times.before).toBeGreaterThan(TWO_DAYS - seconds(60));
  });

  it("bites: the caller's clock as the store's time writes the skewed times — the key two days old for the reader behind, four days young", async () => {
    const times = await timesOf("execution-caller", "caller");

    expect(times.started - times.before).toBeGreaterThan(TWO_DAYS - seconds(60));
    expect(times.started - times.readAt).toBeGreaterThan(2 * TWO_DAYS - seconds(60));
  });
});
