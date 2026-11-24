import { inspect } from "node:util";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { StoreClock, StoreTimeSource } from "@agboss/core";
import { StoredNamesUnreadableError } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { hours } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
} from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { TestApplicationContext } from "../support/application-context.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#1166: a fenced effect's stored result (a `text` column, the work's result as JSON)
 * that is no JSON is the coded `StoredNamesUnreadableError` on its replay, and quotes no stored
 * text (agbossjs/agboss#906 D4-b).
 */
const database = testDatabase();
const SECRET = "ssn-078-05-1166";
const TEXTS = [
  `{"startInput":{"name":"${SECRET}"},"x":undefined}`,
  SECRET,
  `{"startInput":{"name":${SECRET}}}`,
];

describe.each(TEXTS)("a stored fenced effect result that is not JSON: %#", (text) => {
  it("a replay is the coded refusal naming the effect, with no text in it", async () => {
    const clock = new VirtualClock();
    const connection = connectionTo(database.url());
    const effects = new PostgresFencedEffectRepository(
      connection,
      new StoreClock(StoreTimeSource.Test, clock),
    );
    const leases = new PostgresExecutionLeaseRepository(
      connection,
      new StoreClock(StoreTimeSource.Test, clock),
      new TestApplicationContext({}),
    );
    const lease = await leases.acquire(
      "default",
      `root-1166-${String(TEXTS.indexOf(text))}`,
      hours(1),
    );
    if (lease === undefined) throw new Error("the lease is held");
    const key = effectKeyForTesting({
      scopeKey: `default:${lease.rootExecutionId}`,
      tenantId: "default",
      leaseExecutionId: lease.rootExecutionId,
      token: lease.token,
      idempotencyKey: `${lease.rootExecutionId}:charge-action:1`,
      name: "charge",
    });
    await effects.runOnce(key, () => Promise.resolve("done"));
    await connection.pool.query("UPDATE agboss_fenced_effect_results SET result = $1", [text]);

    const error: unknown = await effects
      .runOnce(key, () => Promise.resolve("again"))
      .then(
        () => new Error("it was read"),
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(StoredNamesUnreadableError);
    expect(error).toMatchObject({
      code: "stored.unreadable",
      record: "fenced effect result",
      ids: "name charge",
    });
    expect(inspect(error, { depth: 12 })).not.toContain(SECRET);
    expect(inspect(error, { depth: 12 })).not.toMatch(/startInput|Unexpected|JSON\.parse/);
  });
});
