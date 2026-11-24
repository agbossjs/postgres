import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { StoreClock, StoreTimeSource, IdempotencyRunStatus } from "@agboss/core";
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
 * The tenant and the name of a business key's effect (agbossjs/agboss#1302): the key is one for every
 * tree of its tenant and no other's, and one per effect name, so the same key of two tenants, or
 * under two names, is two effects. Dropping either from the statement that finds the key's row
 * fails these.
 */
const database = testDatabase();

function storesOn(): {
  readonly effects: PostgresFencedEffectRepository;
  readonly leases: PostgresExecutionLeaseRepository;
} {
  const connection = connectionTo(database.url());
  const clock = new StoreClock(StoreTimeSource.Test, new VirtualClock());
  return {
    effects: new PostgresFencedEffectRepository(connection, clock),
    leases: new PostgresExecutionLeaseRepository(connection, clock, new TestApplicationContext({})),
  };
}

const keyOf = (tenantId: string, name: string) =>
  effectKeyForTesting({
    scopeKey: `${tenantId}:root-1`,
    tenantId,
    leaseExecutionId: "root-1",
    token: 1,
    idempotencyKey: `root-1:${name}-action:1`,
    name,
    businessKey: "order:42",
    fingerprint: "f",
    origin: { executionId: "root-1", nodeId: `${name}-action`, visitNumber: 1 },
  });

describe("PostgresFencedEffectRepository: one business key", () => {
  it("of two tenants is two effects: the second tenant's runs, it does not replay the first's", async () => {
    const { effects, leases } = storesOn();
    for (const tenantId of ["tenant-a", "tenant-b"])
      await leases.acquire(tenantId, "root-1", hours(1));

    const first = await effects.runOnce(keyOf("tenant-a", "charge"), () => ({ receipt: "a" }));
    const second = await effects.runOnce(keyOf("tenant-b", "charge"), () => ({ receipt: "b" }));

    expect(first).toMatchObject({ status: IdempotencyRunStatus.Ran, result: { receipt: "a" } });
    expect(second).toMatchObject({ status: IdempotencyRunStatus.Ran, result: { receipt: "b" } });
  });

  it("under two names is two effects: the second name's runs, it does not replay the first's", async () => {
    const { effects, leases } = storesOn();
    await leases.acquire("tenant-c", "root-1", hours(1));

    const first = await effects.runOnce(keyOf("tenant-c", "charge"), () => ({ receipt: "c" }));
    const second = await effects.runOnce(keyOf("tenant-c", "refund"), () => ({ receipt: "r" }));

    expect(first).toMatchObject({ status: IdempotencyRunStatus.Ran, result: { receipt: "c" } });
    expect(second).toMatchObject({ status: IdempotencyRunStatus.Ran, result: { receipt: "r" } });
  });
});
