import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import {
  ExecutionCancelFencedError,
  ExecutionFencedError,
  FencedEffectSettings,
  StoreClock,
  StoreTimeSource,
} from "@agboss/core";
import { OutboundCallLeaseState } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { hours, seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
  migratePostgres,
} from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { freshSchema, onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";
import { blockedBefore, openTransaction, pidOf } from "./pause-locks.js";

/**
 * Each clause of the fence's statements a test proves (agbossjs/agboss#1327): dropping it from the
 * statement, one at a time, fails one of these. Two trees of two tenants share one root id: a
 * statement that names a tree touches no other's. The other tenant's row is the first the table
 * holds, so a read of the root id alone would find it.
 */
const database = testDatabase();
const virtual = new VirtualClock();
const clock = new StoreClock(StoreTimeSource.Test, virtual);

function storesOn(url = database.url()) {
  const connection = connectionTo(url);
  return {
    effects: new PostgresFencedEffectRepository(connection, clock, new FencedEffectSettings()),
    leases: new PostgresExecutionLeaseRepository(connection, clock, new TestApplicationContext({})),
    calls: new PostgresOutboundCallRepository(connection, clock),
  };
}

const keyOf = (tenantId: string, root: string, token: number) =>
  effectKeyForTesting({
    scopeKey: `${tenantId}:${root}`,
    tenantId,
    leaseExecutionId: root,
    token,
    idempotencyKey: `${root}:charge-action:1`,
    name: "charge",
  });

describe("the fence of two trees that share a root id", () => {
  it("reads its own tenant's lease: another tenant's live lease does not hold a released one", async () => {
    const { effects, leases } = storesOn();
    await leases.acquire("tenant-b", "root-fence", hours(1));
    const own = await leases.acquire("tenant-a", "root-fence", hours(1));
    if (own === undefined) throw new Error("no lease taken");
    await leases.release(own);

    const written = await effects
      .runOnce(keyOf("tenant-a", "root-fence", own.token), () => ({ receipt: "r" }))
      .catch((error: unknown) => error);

    expect(written).toBeInstanceOf(ExecutionFencedError);
  });

  it("reads its own tenant's cancel mark: another tenant's cancelled tree does not refuse it", async () => {
    const { effects, leases } = storesOn();
    await leases.acquire("tenant-b", "root-cancel", hours(1));
    await leases.requestCancel({ tenantId: "tenant-b", rootExecutionId: "root-cancel" });
    const own = await leases.acquire("tenant-a", "root-cancel", hours(1));

    const written = await effects
      .runOnce(keyOf("tenant-a", "root-cancel", own?.token ?? 0), () => ({ receipt: "r" }))
      .catch((error: unknown) => error);

    expect(written).not.toBeInstanceOf(ExecutionCancelFencedError);
    expect(written).toMatchObject({ result: { receipt: "r" } });
  });

  it("refreshes the mark's time with every fenced write: a retention keeps a scope in use", async () => {
    const { effects, leases } = storesOn();
    const lease = await leases.acquire("tenant-a", "root-mark-time", hours(1));
    const key = keyOf("tenant-a", "root-mark-time", lease?.token ?? 0);
    await effects.runOnce(key, () => ({ receipt: "r" }));
    await virtual.advance(seconds(10));

    await effects.runOnce(key, () => ({ receipt: "r" }));

    const { rows } = await onSchema(
      database.url(),
      "SELECT stored_at FROM agboss_fenced_effect_marks WHERE scope_key = 'tenant-a:root-mark-time'",
    );
    expect(rows).toEqual([{ stored_at: virtual.now() }]);
  });

  it("closes the expired lease of its own tenant and no other's, and reads its own state", async () => {
    const { calls, leases } = storesOn();
    await leases.acquire("tenant-b", "root-close", seconds(1));
    const own = await leases.acquire("tenant-a", "root-close", seconds(1));
    await virtual.advance(seconds(5));
    const state = { tenantId: "tenant-a", leaseExecutionId: "root-close", token: own?.token ?? 0 };

    expect(await calls.leaseStateOf(state)).toBe(OutboundCallLeaseState.LeaseClosed);

    const { rows } = await onSchema(
      database.url(),
      "SELECT tenant_id, released, superseded FROM agboss_execution_leases WHERE root_execution_id = 'root-close' ORDER BY tenant_id",
    );
    expect(rows).toEqual([
      { tenant_id: "tenant-a", released: true, superseded: true },
      { tenant_id: "tenant-b", released: false, superseded: false },
    ]);
    // released: the state is Ended, whatever the other tenant's lease is
    expect(await calls.leaseStateOf(state)).toBe(OutboundCallLeaseState.Ended);
  });
});

describe("the lease row's lock of a renewal, a yield and a reclaim", () => {
  it("is the row of its own tenant and root: a holder of a twin's row is not waited for", async () => {
    const { leases } = storesOn();
    const own = await leases.acquire("tenant-a", "root-lock", hours(1));
    if (own === undefined) throw new Error("no lease taken");
    await leases.acquire("tenant-b", "root-lock", hours(1));
    await leases.acquire("tenant-a", "root-lock-twin", hours(1));
    const holder = await openTransaction(database.url());
    await holder.query(
      `SELECT 1 FROM agboss_execution_leases
       WHERE root_execution_id IN ('root-lock', 'root-lock-twin') AND NOT (tenant_id = 'tenant-a' AND root_execution_id = 'root-lock')
       FOR UPDATE`,
    );

    const renewing = leases.renew(own, hours(1));
    const isBlocked = await blockedBefore(database.url(), await pidOf(holder), renewing);
    await holder.query("ROLLBACK");
    await holder.end();

    expect(isBlocked).toBe(false);
    expect(await renewing).toBeDefined();
  });
});

describe("the conflicts the inserts of the fence ignore", () => {
  it("of an execution id is its own key's: another unique key's violation is an error", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });
    await onSchema(
      url,
      "CREATE UNIQUE INDEX ids_tenant_unique ON agboss_execution_ids (tenant_id)",
    );
    const { leases } = storesOn(url);

    expect(await leases.claimExecutionId({ executionId: "e-1", tenantId: "tenant-a" })).toBe(true);
    await expect(
      leases.claimExecutionId({ executionId: "e-2", tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("of a root's seed row is its own key's: another unique key's violation is an error", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });
    await onSchema(
      url,
      "CREATE UNIQUE INDEX seed_unique ON agboss_execution_leases (holder_instance_id) WHERE holder_instance_id = ''",
    );
    const { effects, leases } = storesOn(url);
    const childOf = async (child: string, root: string) => {
      const lease = await leases.acquire("tenant-a", child, hours(1));
      return effectKeyForTesting({
        scopeKey: `tenant-a:${child}`,
        tenantId: "tenant-a",
        leaseExecutionId: child,
        rootExecutionId: root,
        token: lease?.token ?? 0,
        idempotencyKey: `${child}:charge-action:1`,
        name: "charge",
      });
    };
    await effects.runOnce(await childOf("child-1", "root-1"), () => ({ receipt: "r" }));

    await expect(
      effects.runOnce(await childOf("child-2", "root-2"), () => ({ receipt: "r" })),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
