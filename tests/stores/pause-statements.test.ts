import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it, vi } from "vitest";
import { PostgresPausedExecutionRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";
import { MID, expiringPauseOf, pauseOf } from "./pause-fixtures.js";

/**
 * How much a change asks of the database (agbossjs/agboss#935, #1213): a change that tells no one is
 * one statement on the pool — no transaction, no notice statement — and one that tells someone is
 * one transaction on one connection. Counted on the pool's own `query`: a statement of a
 * transaction goes through its client, never through it.
 */
const database = testDatabase();

function instrumented(): {
  readonly store: PostgresPausedExecutionRepository;
  readonly poolStatements: () => number;
} {
  const connection = connectionTo(database.url(), 2);
  const query = vi.spyOn(connection.pool, "query");
  return {
    store: new PostgresPausedExecutionRepository(connection, new VirtualClock()),
    poolStatements: () => query.mock.calls.length,
  };
}

const CHANNEL = { channel: "refund-approval-channel", listeners: [] };
const LISTENERS = { listeners: ["audit-listener"] };
const NO_ONE = { listeners: [] };

describe("a change on the pool or in a transaction, by who hears of it", () => {
  it.each([
    ["no one", NO_ONE, 1],
    ["the channel only", CHANNEL, 0],
    ["a listener only", LISTENERS, 0],
    ["the channel and a listener", { ...CHANNEL, ...LISTENERS }, 0],
  ])("a reminder heard by %s asks the pool %i statements", async (who, recipients, statements) => {
    const { store, poolStatements } = instrumented();
    const id = `remind-${who.replaceAll(" ", "-")}`;
    await store.findOrCreateByStepKey(expiringPauseOf(id));
    const before = poolStatements();

    expect(await store.remindByTenantIdAndPauseId("default", id, MID, recipients)).toBe(true);

    expect(poolStatements() - before).toBe(statements);
  });
});

describe("the statements of findOrCreateByStepKey and of ping", () => {
  it("a new pause is one insert; a pause of the step already there is an insert, then a read", async () => {
    const { store, poolStatements } = instrumented();

    await store.findOrCreateByStepKey(pauseOf("fresh"));
    expect(poolStatements()).toBe(1);
    const again = await store.findOrCreateByStepKey({
      ...pauseOf("other"),
      stepKey: "run-1:fresh",
    });

    expect(again.pauseId).toBe("fresh");
    expect(poolStatements()).toBe(3);
  });

  it("ping asks the connection, which asks the database", async () => {
    const { store, poolStatements } = instrumented();

    await store.ping();

    expect(poolStatements()).toBe(1);
  });
});
