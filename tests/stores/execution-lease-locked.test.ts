import { StoreClock, StoreTimeSource, IdempotencyRunStatus } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { hours, seconds } from "@agboss/core/units";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
  requirePostgresTransaction,
} from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { blockedBy, heldWrite } from "../support/held-write.js";
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
    new TestApplicationContext(instanceId),
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

describe("agbossjs/agboss#1302: a take racing a release in progress", () => {
  it("waits for the release and reads it: the lease released is no lease taken over", async () => {
    const clock = new StoreClock(StoreTimeSource.Test, new VirtualClock());
    await leasesOn(clock, "instance-1").acquire("default", "root-released", hours(1));
    // the holder's release, its transaction still open
    const releasing = new pg.Client({ connectionString: database.url() });
    await releasing.connect();
    try {
      const release = heldWrite();
      await release.entered(releasing);
      await releasing.query("BEGIN");
      await releasing.query(
        "UPDATE agboss_execution_leases SET released = true WHERE root_execution_id = $1",
        ["root-released"],
      );
      const take = leasesOn(clock, "instance-2").acquire("default", "root-released", hours(1));

      expect(await blockedBy(database.url(), await release.pid, take)).toBe(true);
      await releasing.query("COMMIT");
      const taken = await take;

      expect(taken).toMatchObject({ holderInstanceId: "instance-2", token: 2 });
      expect(taken).not.toHaveProperty("takenOverFrom");
    } finally {
      await releasing.end();
    }
  });
});

describe("agbossjs/agboss#1302: a fenced write holds its own lease row", () => {
  it("a child's open fenced write: a renewal of the child's lease from another connection waits for it", async () => {
    const clock = new StoreClock(StoreTimeSource.Test, new VirtualClock());
    const connection = connectionTo(database.url());
    const effects = new PostgresFencedEffectRepository(connection, clock);
    await leasesOn(clock, "instance-1").acquire("default", "root-of-1302", hours(1));
    const child = await leasesOn(clock, "instance-1").acquire("default", "child-of-1302", hours(1));
    if (child === undefined) throw new Error("the take must succeed");
    const writer = heldWrite();

    const write = effects.runOnce(
      effectKeyForTesting({
        scopeKey: "default:child-of-1302",
        tenantId: "default",
        leaseExecutionId: "child-of-1302",
        rootExecutionId: "root-of-1302",
        token: child.token,
        idempotencyKey: "child-of-1302:charge-action:1:charge",
        name: "charge",
      }),
      async () => {
        await writer.entered(requirePostgresTransaction());
        await writer.released;
        return { receipt: "r1" };
      },
    );
    const writerPid = await writer.pid;
    const renewal = leasesOn(clock, "instance-1").renew(child, hours(1));

    expect(await blockedBy(database.url(), writerPid, renewal)).toBe(true);
    writer.release();
    expect((await write).status).toBe(IdempotencyRunStatus.Ran);
    expect(await renewal).toBeDefined();
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
