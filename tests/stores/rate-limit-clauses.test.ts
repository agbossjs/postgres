import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresRateLimitRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { blockedBefore, openTransaction, pidOf } from "./pause-locks.js";
import { connectionTo } from "../support/stores.js";

/**
 * Each clause of the slot statements a test proves (agbossjs/agboss#1302): dropping it from the
 * statement, one at a time, fails one of these.
 */
const database = testDatabase();

const limitsOn = (clock: VirtualClock): PostgresRateLimitRepository =>
  new PostgresRateLimitRepository(
    connectionTo(database.url()),
    clock,
    new TestApplicationContext({}, "instance-1"),
  );

const slotsOf = async (key: string): Promise<number> =>
  (
    await onSchema(database.url(), "SELECT 1 FROM agboss_rate_limit_slots WHERE slot_key = $1", [
      key,
    ])
  ).rowCount ?? 0;

describe("PostgresRateLimitRepository: the statements' clauses", () => {
  it("an acquire sweeps the expired slots of its own key only: another key's row is left to its own", async () => {
    const clock = new VirtualClock();
    const limits = limitsOn(clock);
    await limits.acquire("swept-other", 1, seconds(30));
    await clock.advance(seconds(31));

    await limits.acquire("swept-own", 1, seconds(30));

    const { rows } = await onSchema(
      database.url(),
      "SELECT slot_key FROM agboss_rate_limit_slots WHERE slot_key LIKE 'swept-%' ORDER BY slot_key",
    );
    expect(rows).toEqual([{ slot_key: "swept-other" }, { slot_key: "swept-own" }]);
  });

  it("a release frees its own slot only", async () => {
    const limits = limitsOn(new VirtualClock());
    const mine = await limits.acquire("released-key", 2, seconds(30));
    await limits.acquire("released-key", 2, seconds(30));
    if (mine === undefined) throw new Error("no slot was taken");

    await limits.release(mine);

    expect(await slotsOf("released-key")).toBe(1);
  });

  it("an acquire locks its own key's row only: another key's holder is not waited for", async () => {
    const limits = limitsOn(new VirtualClock());
    await limits.acquire("other-key", 1, seconds(30));
    const holder = await openTransaction(database.url());
    await holder.query(
      "SELECT 1 FROM agboss_rate_limit_keys WHERE limit_key = 'other-key' FOR UPDATE",
    );

    const acquiring = limits.acquire("own-key", 1, seconds(30));
    const isBlocked = await blockedBefore(database.url(), await pidOf(holder), acquiring);
    await holder.query("ROLLBACK");
    await holder.end();

    expect(isBlocked).toBe(false);
    expect(await acquiring).toBeDefined();
  });

  it("a window count forgets the buckets of its own key only", async () => {
    const clock = new VirtualClock();
    const limits = limitsOn(clock);
    await limits.addToWindow("window-other", 1, seconds(10));
    await clock.advance(seconds(11));

    await limits.addToWindow("window-own", 1, seconds(10), 5);

    const { rows } = await onSchema(
      database.url(),
      "SELECT window_key FROM agboss_rate_limit_window_buckets WHERE window_key LIKE 'window-%' ORDER BY 1",
    );
    expect(rows).toEqual([{ window_key: "window-other" }, { window_key: "window-own" }]);
  });

  it("a pause is kept at the later of the stored time and the new one", async () => {
    const clock = new VirtualClock();
    const limits = limitsOn(clock);
    const at = (offset: number): Date => new Date(clock.now().getTime() + seconds(offset));

    await limits.pauseUntil("paused-key", at(30));
    await limits.pauseUntil("paused-key", at(10));
    expect(await limits.pausedUntil("paused-key")).toEqual(at(30));

    await limits.pauseUntil("paused-key", at(60));
    expect(await limits.pausedUntil("paused-key")).toEqual(at(60));
  });
});
