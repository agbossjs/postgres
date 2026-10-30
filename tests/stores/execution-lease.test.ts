import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { TestApplicationContext } from "../support/application-context.js";
import { connectionTo } from "../support/stores.js";

/** The lease's edges: a lease already over is not revived; a lost connection rejects. */
const database = testDatabase();

const leasesOn = (clock: VirtualClock, instanceId = "instance-1") =>
  new PostgresExecutionLeaseRepository(
    connectionTo(database.url()),
    clock,
    new TestApplicationContext({}, instanceId),
  );

describe("PostgresExecutionLeaseRepository", () => {
  it("a renewal after the lease ended is refused, even when nobody took it: the holder gave it up", async () => {
    const clock = new VirtualClock();
    const leases = leasesOn(clock);
    const held = await leases.acquire("default", "root-over", seconds(30));

    await clock.advance(seconds(31));

    expect(held && (await leases.renew(held, seconds(30)))).toBe(false);
    expect(
      await leasesOn(clock, "instance-2").acquire("default", "root-over", seconds(30)),
    ).toMatchObject({
      holderInstanceId: "instance-2",
      leaseEpoch: 2,
    });
  });

  it("a takeover at the very moment the lease ends is allowed: valid while expires_at > now", async () => {
    const clock = new VirtualClock();
    await leasesOn(clock).acquire("default", "root-edge", seconds(30));

    await clock.advance(seconds(30));

    expect(
      await leasesOn(clock, "instance-2").acquire("default", "root-edge", seconds(30)),
    ).toMatchObject({
      leaseEpoch: 2,
    });
  });

  it("a lost connection rejects acquire, renew and release: the core's holder hands the tree over", async () => {
    const clock = new VirtualClock();
    const down = new PostgresExecutionLeaseRepository(
      connectionTo("postgres://postgres:pw@127.0.0.1:1/postgres"),
      clock,
      new TestApplicationContext({}),
    );
    const lease = {
      tenantId: "default",
      rootExecutionId: "root-down",
      holderInstanceId: "instance-1",
      leaseEpoch: 1,
      expiresAt: clock.now(),
    };

    await expect(down.acquire("default", "root-down", seconds(30))).rejects.toThrow();
    await expect(down.renew(lease, seconds(30))).rejects.toThrow();
    await expect(down.release(lease)).rejects.toThrow();
    await expect(down.ping()).rejects.toThrow();
  });
});
