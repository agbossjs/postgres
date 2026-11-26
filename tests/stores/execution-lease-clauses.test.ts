import { StoreClock, StoreTimeSource, type ExecutionLease } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * Each clause of the lease statements a test proves (agbossjs/agboss#1327): dropping it from the
 * statement, one at a time, fails one of these. A lease's twins hold the same holder and token under
 * another tenant, or another root: a statement that names a lease changes it and no twin.
 */
const database = testDatabase();
const virtual = new VirtualClock();
const clock = new StoreClock(StoreTimeSource.Test, virtual);
const LEASE = seconds(30);

const leasesOn = (instanceId: string): PostgresExecutionLeaseRepository =>
  new PostgresExecutionLeaseRepository(
    connectionTo(database.url()),
    clock,
    new TestApplicationContext(instanceId),
  );

const rowOf = async (tenantId: string, root: string): Promise<string> =>
  JSON.stringify(
    (
      await onSchema(
        database.url(),
        "SELECT * FROM agboss_execution_leases WHERE tenant_id = $1 AND root_execution_id = $2",
        [tenantId, root],
      )
    ).rows,
  );

/** A lease of `root` under `tenant-a`, and its twins: the same holder and token under another tenant, and another root. */
async function withTwins(root: string): Promise<{
  readonly held: ExecutionLease;
  readonly twins: readonly (readonly [string, string])[];
}> {
  const held = await leasesOn("holder-1").acquire("tenant-a", root, LEASE);
  if (held === undefined) throw new Error("no lease taken");
  const twins = [
    ["tenant-b", root],
    ["tenant-a", `${root}-twin`],
  ] as const;
  for (const [tenantId, twinRoot] of twins)
    await onSchema(
      database.url(),
      `INSERT INTO agboss_execution_leases (tenant_id, root_execution_id, holder_instance_id, token,
         expires_at, released, yielded, superseded)
       SELECT $3, $4, holder_instance_id, token, expires_at, released, yielded, superseded
       FROM agboss_execution_leases WHERE tenant_id = $1 AND root_execution_id = $2`,
      [held.tenantId, held.rootExecutionId, tenantId, twinRoot],
    );
  return { held, twins };
}

const operations = {
  renew: (leases: PostgresExecutionLeaseRepository, held: ExecutionLease) =>
    leases.renew(held, LEASE),
  yield: (leases: PostgresExecutionLeaseRepository, held: ExecutionLease) => leases.yield(held),
  reclaim: (leases: PostgresExecutionLeaseRepository, held: ExecutionLease) =>
    leases.reclaim(held, LEASE),
  release: (leases: PostgresExecutionLeaseRepository, held: ExecutionLease) => leases.release(held),
  retire: (leases: PostgresExecutionLeaseRepository, held: ExecutionLease) => leases.retire(held),
};

describe.each(Object.entries(operations))("%s", (name, operate) => {
  it("changes the lease it names and no twin of it", async () => {
    const { held, twins } = await withTwins(`root-${name}-twins`);
    const before = await Promise.all(twins.map(([tenant, root]) => rowOf(tenant, root)));
    const own = await rowOf(held.tenantId, held.rootExecutionId);

    // a second later, so a renewal is a change
    await virtual.advance(seconds(1));
    await operate(leasesOn("holder-1"), held);

    expect(await rowOf(held.tenantId, held.rootExecutionId)).not.toBe(own);
    expect(await Promise.all(twins.map(([tenant, root]) => rowOf(tenant, root)))).toEqual(before);
  });

  it("changes nothing for another holder, nor for another token", async () => {
    const { held } = await withTwins(`root-${name}-others`);
    const own = await rowOf(held.tenantId, held.rootExecutionId);

    await operate(leasesOn("intruder"), { ...held, holderInstanceId: "intruder" });
    await operate(leasesOn("holder-1"), { ...held, token: held.token + 1 });

    expect(await rowOf(held.tenantId, held.rootExecutionId)).toBe(own);
  });
});

describe("a take of a lease released after a yield and a close", () => {
  it("starts it clean: held, not yielded, not superseded", async () => {
    const held = await leasesOn("holder-1").acquire("tenant-a", "root-clean", LEASE);
    if (held === undefined) throw new Error("no lease taken");
    await onSchema(
      database.url(),
      `UPDATE agboss_execution_leases SET released = true, yielded = true, superseded = true
       WHERE root_execution_id = 'root-clean'`,
    );

    await leasesOn("holder-2").acquire("tenant-a", "root-clean", LEASE);

    const { rows } = await onSchema(
      database.url(),
      `SELECT holder_instance_id, token, released, yielded, superseded FROM agboss_execution_leases
       WHERE root_execution_id = 'root-clean'`,
    );
    expect(rows).toEqual([
      {
        holder_instance_id: "holder-2",
        token: 2,
        released: false,
        yielded: false,
        superseded: false,
      },
    ]);
  });
});
