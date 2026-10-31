import { TestStoreClock } from "@agboss/core";
import type { ExecutionLease } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds, type Milliseconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { TestApplicationContext } from "../support/application-context.js";
import { connectionTo } from "../support/stores.js";

/**
 * Acceptance corner cases of a yielded lease on PostgreSQL (agbossjs/agboss#516): its row says
 * `yielded` and its expiry moves with each renewal (M2, read from the table); 1 ms before its
 * expiry it still blocks; once expired, a reclaim racing a take leaves exactly one holder, again
 * and again.
 */
const database = testDatabase();
const LEASE = seconds(30);

/** A naive reclaim: it never asks whether another instance took the lease meanwhile. */
class BlindReclaim extends PostgresExecutionLeaseRepository {
  override async reclaim(lease: ExecutionLease, duration: Milliseconds) {
    const reclaimed = await super.reclaim(lease, duration);
    return reclaimed ?? { ...lease, leaseEpoch: lease.leaseEpoch + 1 };
  }
}

const leasesOn = (
  clock: VirtualClock,
  instanceId: string,
  Store = PostgresExecutionLeaseRepository,
) =>
  new Store(
    connectionTo(database.url()),
    new TestStoreClock(clock),
    new TestApplicationContext({}, instanceId),
  );

const rowOf = async (root: string): Promise<unknown> =>
  (
    await onSchema(
      database.url(),
      `SELECT holder_instance_id, lease_epoch, yielded, expires_at
       FROM agboss_execution_leases WHERE root_execution_id = $1`,
      [root],
    )
  ).rows[0];

describe("#516 acceptance: a yielded lease on PostgreSQL", () => {
  it("M2 (AC4): the row is yielded, its holder kept, and a renewal moves expires_at on", async () => {
    const clock = new VirtualClock();
    const first = leasesOn(clock, "instance-1");
    const held = await first.acquire("default", "root-m2", LEASE);
    expect(held && (await first.yield(held))).toBe(true);
    const before = await rowOf("root-m2");

    await clock.advance(seconds(10));
    expect(held && (await first.renew(held, LEASE))).toBe(LEASE);

    expect(before).toMatchObject({
      holder_instance_id: "instance-1",
      lease_epoch: 1,
      yielded: true,
    });
    expect(await rowOf("root-m2")).toMatchObject({
      yielded: true,
      expires_at: new Date(clock.now().getTime() + LEASE),
    });
  });

  it("AC4: 1 ms before its expiry a yielded lease still blocks another instance", async () => {
    const clock = new VirtualClock();
    const held = await leasesOn(clock, "instance-1").acquire("default", "root-edge", LEASE);
    expect(held && (await leasesOn(clock, "instance-1").yield(held))).toBe(true);

    await clock.advance(seconds(29.999));

    expect(await leasesOn(clock, "instance-2").acquire("default", "root-edge", LEASE)).toBe(
      undefined,
    );
  });

  /** One round: an expired yielded lease, reclaimed and taken at once — how many hold it. */
  const holdersAfterRace = async (round: string, Store = PostgresExecutionLeaseRepository) => {
    const clock = new VirtualClock();
    const [first, second] = [leasesOn(clock, "instance-1", Store), leasesOn(clock, "instance-2")];
    const root = `root-race-${round}`;
    const held = await first.acquire("default", root, LEASE);
    expect(held && (await first.yield(held))).toBe(true);
    await clock.advance(seconds(30.001));

    const [taken, reclaimed] = await Promise.all([
      second.acquire("default", root, LEASE),
      held && first.reclaim(held, LEASE),
    ]);
    return [taken, reclaimed].filter((lease) => lease !== undefined).length;
  };

  it("AC4: an expired yielded lease, reclaimed and taken at once, has exactly one holder (10 rounds)", async () => {
    for (let round = 0; round < 10; round += 1) {
      expect(await holdersAfterRace(String(round))).toBe(1);
      expect(await rowOf(`root-race-${String(round)}`)).toMatchObject({ lease_epoch: 2 });
    }
  });

  it("AC4: the race check bites — a naive reclaim that ignores the takeover gives two holders", async () => {
    expect(await holdersAfterRace("naive", BlindReclaim)).toBe(2);
  });
});
