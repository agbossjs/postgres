import type { ExecutionLease } from "@agboss/core";
import { VirtualClock, TestStoreClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#520: the finish, the release and an acquire in each order PostgreSQL can run them.
 * A transaction holds the lease row locked; the calls are queued behind it one by one (each seen
 * waiting on that transaction before the next is sent), then the lock is let go and they run in
 * that order — so the orders a free race rarely hits (the acquire first) are each run.
 */
const database = testDatabase();
const LEASE = seconds(30);

type Call = "finish" | "release" | "acquire";

const leasesOn = (clock: VirtualClock, instanceId: string) =>
  new PostgresExecutionLeaseRepository(
    connectionTo(database.url(), 1),
    new TestStoreClock(clock),
    new TestApplicationContext({}, instanceId),
  );

/** The sessions waiting on the session `pid`, directly or behind another waiter (a tuple lock). */
const WAITING = `WITH RECURSIVE waiter(pid) AS (
    SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
    UNION
    SELECT activity.pid FROM pg_stat_activity AS activity
      JOIN waiter ON waiter.pid = ANY(pg_blocking_pids(activity.pid))
  )
  SELECT count(*)::int AS waiting FROM waiter`;

const WaitingRow = z.object({ waiting: z.number() });

/** How many sessions wait on the session `pid`'s locks. */
async function waitingOn(pid: number): Promise<number> {
  const { rows } = await onSchema(database.url(), WAITING, [pid]);
  return WaitingRow.parse(rows[0]).waiting;
}

/** Resolves once `count` sessions wait on `pid` (the test's timeout bounds it). */
async function untilWaiting(pid: number, count: number): Promise<void> {
  while ((await waitingOn(pid)) < count) await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * `calls` run on `root`'s lease (held by instance-1, `isExpired` past its end) in that order, each
 * on a connection of its own; what the acquire got and the row after them.
 */
async function inOrder(root: string, calls: readonly Call[], isExpired: boolean) {
  const clock = new VirtualClock();
  const stores = calls.map((call) =>
    leasesOn(clock, call === "acquire" ? "instance-2" : "instance-1"),
  );
  const held = await leasesOn(clock, "instance-1").acquire("default", root, LEASE);
  if (held === undefined) throw new Error(`the first acquire of ${root} must take it`);
  await Promise.all(stores.map((store) => store.ping()));
  if (isExpired) await clock.advance(seconds(31));
  const blocker = new pg.Client({ connectionString: database.url() });
  await blocker.connect();
  const { rows } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = rows[0]?.pid ?? 0;
  await blocker.query("BEGIN");
  await blocker.query(
    "SELECT 1 FROM agboss_execution_leases WHERE root_execution_id = $1 FOR UPDATE",
    [root],
  );
  const running: Promise<ExecutionLease | undefined>[] = [];
  for (const [at, call] of calls.entries()) {
    const store = stores[at];
    if (store === undefined) continue;
    running.push(
      call === "acquire"
        ? store.acquire("default", root, LEASE)
        : store[call](held).then(() => undefined),
    );
    await untilWaiting(pid, at + 1);
  }
  await blocker.query("COMMIT");
  await blocker.end();
  const taken = (await Promise.all(running)).find((result) => result !== undefined);
  const after = await onSchema(
    database.url(),
    "SELECT lease_epoch, finished FROM agboss_execution_leases WHERE root_execution_id = $1",
    [root],
  );
  return { taken, row: after.rows[0] };
}

describe("finish, release and acquire in each order (agbossjs/agboss#520)", () => {
  it("past the lease, the acquire before the finish: taken at epoch 2, and the finish matches nothing", async () => {
    const { taken, row } = await inOrder("root-a", ["acquire", "finish"], true);

    expect(taken).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
    expect(row).toEqual({ lease_epoch: 2, finished: false });
  });

  it("past the lease, the finish before the acquire: refused, finished at epoch 1", async () => {
    const { taken, row } = await inOrder("root-b", ["finish", "acquire"], true);

    expect(taken).toBeUndefined();
    expect(row).toEqual({ lease_epoch: 1, finished: true });
  });

  it("a valid lease released, then acquired, then finished: taken at epoch 2, not finished", async () => {
    const { taken, row } = await inOrder("root-c", ["release", "acquire", "finish"], false);

    expect(taken).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
    expect(row).toEqual({ lease_epoch: 2, finished: false });
  });

  it("a valid lease released, then finished, then acquired: refused, finished", async () => {
    const { taken, row } = await inOrder("root-d", ["release", "finish", "acquire"], false);

    expect(taken).toBeUndefined();
    expect(row).toEqual({ lease_epoch: 1, finished: true });
  });

  it("a valid lease finished, then released, then acquired: the release keeps it finished", async () => {
    const { taken, row } = await inOrder("root-e", ["finish", "release", "acquire"], false);

    expect(taken).toBeUndefined();
    expect(row).toEqual({ lease_epoch: 1, finished: true });
  });
});
