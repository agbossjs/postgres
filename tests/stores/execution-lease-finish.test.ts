import { TestStoreClock } from "@agboss/core";
import type { ExecutionLease } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#520 on PostgreSQL, beyond the contract's two instances: six connections racing
 * the holder's `finish` and `release` against five other instances' `acquire`, and the edges of
 * `finish` — a stale epoch, an expired lease, a second finish.
 */
const database = testDatabase();

/**
 * Connections per race: the holder's finish, the holder's release (the same instance, a pool each)
 * and four other instances' acquires; rounds per race.
 */
const ACQUIRERS = 4;
const ROUNDS = 15;
const LEASE = seconds(30);

const leasesOn = (clock: VirtualClock, instanceId: string) =>
  new PostgresExecutionLeaseRepository(
    connectionTo(database.url(), 1),
    new TestStoreClock(clock),
    new TestApplicationContext({}, instanceId),
  );

/** The stored row of `root`: its epoch and whether it is finished. */
async function rowOf(root: string): Promise<unknown> {
  const { rows } = await onSchema(
    database.url(),
    `SELECT lease_epoch, finished FROM agboss_execution_leases
     WHERE tenant_id = 'default' AND root_execution_id = $1`,
    [root],
  );
  return rows[0];
}

async function takenBy(
  leases: PostgresExecutionLeaseRepository,
  root: string,
): Promise<ExecutionLease> {
  const held = await leases.acquire("default", root, LEASE);
  if (held === undefined) throw new Error(`the first acquire of ${root} must take it`);
  return held;
}

/** The six racers of one round: the holder of `root`'s lease on two connections, four acquirers. */
function racersOn(clock: VirtualClock) {
  const holder = leasesOn(clock, "instance-1");
  const releaser = leasesOn(clock, "instance-1");
  const acquirers = Array.from({ length: ACQUIRERS }, (_, at) =>
    leasesOn(clock, `instance-${String(at + 2)}`),
  );
  return { holder, releaser, acquirers };
}

/** The round's calls, sent in an order the round picks: release, finish or the acquires first. */
function sentInOrder<T>(round: number, calls: readonly (() => Promise<T>)[]): Promise<T[]> {
  const shift = round % calls.length;
  const order = [...calls.slice(shift), ...calls.slice(0, shift)];
  const results = order.map((call) => call());
  // back in the calls' own order: the first two are the finish and the release
  return Promise.all([
    ...results.slice(calls.length - shift),
    ...results.slice(0, calls.length - shift),
  ]);
}

/**
 * One round: the holder finishes and releases its lease while four instances acquire it, all at
 * once on six connections. At most one acquire wins; if one did, the finish matched nothing (its
 * lease is renewed and, released, taken again at the next epoch); if none did, the row is finished
 * at the holder's epoch and refused for good.
 */
async function raceRound(
  root: string,
  round: number,
  isExpired: boolean,
): Promise<"taken" | "finished"> {
  const clock = new VirtualClock();
  const { holder, releaser, acquirers } = racersOn(clock);
  const held = await takenBy(holder, root);
  // every pool connected before the race: no racer waits for its connection
  await Promise.all([releaser, ...acquirers].map((store) => store.ping()));
  if (isExpired) await clock.advance(seconds(31));

  const [, , ...takes] = await sentInOrder<ExecutionLease | undefined>(round, [
    () => holder.finish(held).then(() => undefined),
    () => releaser.release(held).then(() => undefined),
    ...acquirers.map((acquirer) => () => acquirer.acquire("default", root, LEASE)),
  ]);

  const won = takes.flatMap((take, at) => (take === undefined ? [] : [{ take, at }]));
  expect(won.length).toBeLessThanOrEqual(1);
  const [winner] = won;
  if (winner === undefined) {
    expect(await rowOf(root)).toEqual({ lease_epoch: 1, finished: true });
    await clock.advance(seconds(31));
    expect(await acquirers[0]?.acquire("default", root, LEASE)).toBeUndefined();
    return "finished";
  }
  const store = acquirers[winner.at];
  expect(winner.take.leaseEpoch).toBe(2);
  expect(await rowOf(root)).toEqual({ lease_epoch: 2, finished: false });
  expect(await store?.renew(winner.take, LEASE)).toBe(LEASE);
  await store?.release(winner.take);
  expect(await holder.acquire("default", root, LEASE)).toMatchObject({ leaseEpoch: 3 });
  return "taken";
}

describe("PostgresExecutionLeaseRepository.finish (agbossjs/agboss#520)", () => {
  it("six connections: finish and release against four acquires of a valid lease — at most one take, and never of a finished row", async () => {
    const outcomes = [];
    for (let round = 0; round < ROUNDS; round += 1)
      outcomes.push(await raceRound(`root-valid-${String(round)}`, round, false));

    expect(outcomes).toHaveLength(ROUNDS);
  });

  it("six connections: finish and release against four acquires past the lease — at most one take, and never of a finished row", async () => {
    const outcomes = [];
    for (let round = 0; round < ROUNDS; round += 1)
      outcomes.push(await raceRound(`root-expired-${String(round)}`, round, true));

    expect(outcomes).toHaveLength(ROUNDS);
  });

  it("a finish at a stale epoch is refused: the holder's own reclaimed lease is kept, not finished", async () => {
    const clock = new VirtualClock();
    const holder = leasesOn(clock, "instance-1");
    const stale = await takenBy(holder, "root-stale");
    const reclaimed = await holder.reclaim(stale, LEASE);

    await holder.finish(stale);

    expect(reclaimed).toMatchObject({ leaseEpoch: 2 });
    expect(await rowOf("root-stale")).toEqual({ lease_epoch: 2, finished: false });
    expect(reclaimed && (await holder.renew(reclaimed, LEASE))).toBe(LEASE);
  });

  it("an expired lease nobody took is finished by its holder: refused for good", async () => {
    const clock = new VirtualClock();
    const holder = leasesOn(clock, "instance-1");
    const held = await takenBy(holder, "root-expired");
    await clock.advance(seconds(31));

    await holder.finish(held);

    expect(await rowOf("root-expired")).toEqual({ lease_epoch: 1, finished: true });
    expect(
      await leasesOn(clock, "instance-2").acquire("default", "root-expired", LEASE),
    ).toBeUndefined();
  });

  it("a second finish changes nothing: still finished at its epoch, still refused", async () => {
    const clock = new VirtualClock();
    const holder = leasesOn(clock, "instance-1");
    const held = await takenBy(holder, "root-twice");

    await holder.finish(held);
    await holder.finish(held);

    expect(await rowOf("root-twice")).toEqual({ lease_epoch: 1, finished: true });
    expect(await holder.acquire("default", "root-twice", LEASE)).toBeUndefined();
  });

  it("a released lease its holder then finishes is finished: no later take", async () => {
    const clock = new VirtualClock();
    const holder = leasesOn(clock, "instance-1");
    const held = await takenBy(holder, "root-released");
    await holder.release(held);

    await holder.finish(held);

    expect(await rowOf("root-released")).toEqual({ lease_epoch: 1, finished: true });
    expect(
      await leasesOn(clock, "instance-2").acquire("default", "root-released", LEASE),
    ).toBeUndefined();
  });
});
