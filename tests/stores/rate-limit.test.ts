import { VirtualClock } from "@agboss/core/testing";
import { minutes, seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresRateLimitRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * The rate limits' edges beyond the contract, two instances on two pools: racing acquires never
 * pass `maxSlots`, an expired slot's row is reclaimed, racing window counts never pass the limit, a
 * plain read neither locks nor forgets, one millisecond is one bucket, a 429 pause and an open
 * breaker set on one instance hold on the other, and a lost connection rejects.
 */
const database = testDatabase();

const instancesOn = (clock: VirtualClock, url = database.url()) =>
  ["instance-1", "instance-2"].map(
    (id) =>
      new PostgresRateLimitRepository(connectionTo(url), clock, new TestApplicationContext({}, id)),
  ) as [PostgresRateLimitRepository, PostgresRateLimitRepository];

const LEASE = seconds(30);
const MINUTE = minutes(1);

const countOf = async (sql: string, key: string): Promise<number> =>
  (await onSchema(database.url(), sql, [key])).rowCount ?? 0;

describe("PostgresRateLimitRepository", () => {
  it("twenty racing acquires on two instances take exactly maxSlots slots", async () => {
    const [first, second] = instancesOn(new VirtualClock());

    const taken = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).acquire("race-slots", 3, LEASE),
      ),
    );

    expect(taken.filter((slot) => slot !== undefined)).toHaveLength(3);
    expect(
      await countOf("SELECT 1 FROM agboss_rate_limit_slots WHERE slot_key = $1", "race-slots"),
    ).toBe(3);
  });

  it("an expired slot's row is reclaimed by the next acquire; a released one cannot be renewed", async () => {
    const clock = new VirtualClock();
    const [first, second] = instancesOn(clock);
    const abandoned = await first.acquire("reclaimed", 1, LEASE);
    await clock.advance(LEASE);

    const taken = await second.acquire("reclaimed", 1, LEASE);
    if (taken !== undefined) await second.release(taken);

    expect(abandoned).toBeDefined();
    expect(taken).toMatchObject({ holderInstanceId: "instance-2" });
    expect(
      await countOf("SELECT 1 FROM agboss_rate_limit_slots WHERE slot_key = $1", "reclaimed"),
    ).toBe(0);
    expect(taken && (await second.renew(taken, LEASE))).toBe(false);
  });

  it("racing counts of two instances never pass the window's limit", async () => {
    const [first, second] = instancesOn(new VirtualClock());

    const totals = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).addToWindow("race-window", 1, MINUTE, 5),
      ),
    );

    expect(totals.filter((total) => total !== undefined).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(await first.addToWindow("race-window", 0, MINUTE)).toBe(5);
  });

  it("one millisecond is one bucket; a plain read forgets nothing, a counted one forgets the old", async () => {
    const clock = new VirtualClock();
    const [first, second] = instancesOn(clock);
    await first.addToWindow("buckets", 2, MINUTE);
    await second.addToWindow("buckets", 3, MINUTE);
    const bucketsOf = () =>
      countOf("SELECT 1 FROM agboss_rate_limit_window_buckets WHERE window_key = $1", "buckets");
    expect(await bucketsOf()).toBe(1);

    await clock.advance(MINUTE);
    expect(await first.addToWindow("buckets", 0, MINUTE)).toBe(0);
    expect(await bucketsOf()).toBe(1);
    expect(await first.addToWindow("buckets", 0, MINUTE, 10)).toBe(0);

    expect(await bucketsOf()).toBe(0);
  });

  it("a refused count counts nothing; a limit exactly reached is allowed", async () => {
    const [first, second] = instancesOn(new VirtualClock());

    expect(await first.addToWindow("exact", 4, MINUTE, 5)).toBe(4);
    expect(await second.addToWindow("exact", 2, MINUTE, 5)).toBeUndefined();
    expect(await second.addToWindow("exact", 1, MINUTE, 5)).toBe(5);
    expect(await first.addToWindow("exact", 0, MINUTE)).toBe(5);
  });

  it("a 429 pause set on one instance holds on the other, on its clock, until it ends", async () => {
    const clock = new VirtualClock();
    const [first, second] = instancesOn(clock);
    const until = new Date(clock.now().getTime() + 5_000);

    await first.pauseUntil("provider:cooldown", until);

    expect(await second.pausedUntil("provider:cooldown")).toEqual(until);
    await clock.advance(seconds(5));
    expect(await second.pausedUntil("provider:cooldown")).toBeUndefined();
  });

  it("a breaker opened on one instance blocks the other; its failures cleared start anew", async () => {
    const clock = new VirtualClock();
    const [first, second] = instancesOn(clock);
    await first.addToWindow("provider:failures", 1, MINUTE);
    const failures = await second.addToWindow("provider:failures", 1, MINUTE);
    await second.pauseUntil("provider:open", new Date(clock.now().getTime() + 10_000));
    await second.clearWindow("provider:failures");

    expect(failures).toBe(2);
    expect(await first.pausedUntil("provider:open")).toBeDefined();
    expect(await first.addToWindow("provider:failures", 0, MINUTE)).toBe(0);
  });

  it("a lost connection rejects ping and every operation", async () => {
    const clock = new VirtualClock();
    const [down] = instancesOn(clock, "postgres://postgres:pw@127.0.0.1:1/postgres");
    const lease = { key: "k", slotId: "s", holderInstanceId: "instance-1", expiresAt: clock.now() };

    await expect(down.ping()).rejects.toThrow();
    await expect(down.acquire("k", 1, LEASE)).rejects.toThrow();
    await expect(down.renew(lease, LEASE)).rejects.toThrow();
    await expect(down.release(lease)).rejects.toThrow();
    await expect(down.addToWindow("k", 0, MINUTE)).rejects.toThrow();
    await expect(down.addToWindow("k", 1, MINUTE, 2)).rejects.toThrow();
    await expect(down.clearWindow("k")).rejects.toThrow();
    await expect(down.pauseUntil("k", clock.now())).rejects.toThrow();
    await expect(down.pausedUntil("k")).rejects.toThrow();
  });
});
