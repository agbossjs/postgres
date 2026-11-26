import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { StoreClock, StoreTimeSource, ExecutionError } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { hours } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
} from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * The scope's mark is a fence of its own (#500): a key whose lease row holds its token is still
 * refused when a newer token wrote its scope — a lease row restored from a backup, or set back by
 * hand, never lets an older token write again.
 */
const database = testDatabase();

describe("the scope's mark", () => {
  it("a mark above the key's token refuses it: ExecutionError.Fenced naming the mark, nothing runs", async () => {
    const connection = connectionTo(database.url());
    const clock = new StoreClock(StoreTimeSource.Test, new VirtualClock());
    const leases = new PostgresExecutionLeaseRepository(
      connection,
      clock,
      new TestApplicationContext(),
    );
    const effects = new PostgresFencedEffectRepository(connection, clock);
    const lease = await leases.acquire("default", "root-mark", hours(1));
    const token = lease?.token ?? 0;
    // a newer token of this scope wrote before the lease row was set back to `token`
    await onSchema(
      database.url(),
      "INSERT INTO agboss_fenced_effect_marks (scope_key, highest_token, stored_at) VALUES ($1, $2, now())",
      ["default:root-mark", token + 5],
    );
    let runs = 0;

    const error = await effects
      .runOnce(
        effectKeyForTesting({
          scopeKey: "default:root-mark",
          tenantId: "default",
          leaseExecutionId: "root-mark",
          token,
          idempotencyKey: "root-mark:charge-action:1:charge",
          name: "charge",
        }),
        () => {
          runs += 1;
          return { receipt: "r1" };
        },
      )
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ExecutionError.Fenced);
    expect(error).toMatchObject({ scopeKey: "default:root-mark", token, observedToken: token + 5 });
    expect(runs).toBe(0);
  });
});
