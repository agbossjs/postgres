import { StoreClock, StoreTimeSource } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * What an acquire answers about the lease before it (`takenOverFrom` only on a takeover), and the
 * order of a renewal behind a row another transaction holds (agbossjs/agboss#533 review M1): the row
 * is locked first, the database's time read after the wait — a lease that ended while its renewal
 * waited is not extended.
 */
const database = testDatabase();

const leasesOn = (store: StoreClock, instanceId: string) =>
  new PostgresExecutionLeaseRepository(
    connectionTo(database.url()),
    store,
    new TestApplicationContext({}, instanceId),
  );

const WaitingRow = z.object({ waiting: z.number() });

/** Resolves once a session waits on the session `pid`'s locks (the test's timeout bounds it). */
async function untilWaitingOn(pid: number): Promise<void> {
  for (;;) {
    const { rows } = await onSchema(
      database.url(),
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [pid],
    );
    if (WaitingRow.parse(rows[0]).waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("acquire: the lease before it", () => {
  it("a first take, and a take after a release, name no lease taken over", async () => {
    const clock = new StoreClock(StoreTimeSource.Test, new VirtualClock());
    const leases = leasesOn(clock, "instance-1");

    const first = await leases.acquire("default", "root-first", seconds(30));
    if (first !== undefined) await leases.release(first);
    const again = await leasesOn(clock, "instance-2").acquire("default", "root-first", seconds(30));

    expect(first).toBeDefined();
    expect(first).not.toHaveProperty("takenOverFrom");
    expect(again).toMatchObject({ holderInstanceId: "instance-2", token: 2 });
    expect(again).not.toHaveProperty("takenOverFrom");
  });

  it("a take of an expired lease names it: its holder and token", async () => {
    const virtual = new VirtualClock();
    const clock = new StoreClock(StoreTimeSource.Test, virtual);
    await leasesOn(clock, "instance-1").acquire("default", "root-expired", seconds(30));
    await virtual.advance(seconds(31));

    const taken = await leasesOn(clock, "instance-2").acquire(
      "default",
      "root-expired",
      seconds(30),
    );

    expect(taken?.takenOverFrom).toEqual({ holderInstanceId: "instance-1", token: 1 });
  });
});

describe("renew behind a locked row (agbossjs/agboss#533 review M1)", () => {
  it("a lease that ends while its renewal waits for the row is not extended", async () => {
    const leases = leasesOn(new StoreClock(StoreTimeSource.Database, new VirtualClock()), "i-1");
    const held = await leases.acquire("default", "root-m1", seconds(1));
    if (held === undefined) throw new Error("the take must succeed");
    // a fenced write's transaction holds the lease row
    const blocker = new pg.Client({ connectionString: database.url() });
    await blocker.connect();
    try {
      const { rows } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM agboss_execution_leases WHERE root_execution_id = $1 FOR UPDATE",
        ["root-m1"],
      );
      const renewed = leases.renew(held, seconds(30));
      await untilWaitingOn(rows[0]?.pid ?? 0);
      // the lease ends on the database's clock while the renewal waits
      await blocker.query("SELECT pg_sleep(1.5)");
      await blocker.query("COMMIT");

      expect(await renewed).toBeUndefined();
    } finally {
      await blocker.end();
    }
  });
});
