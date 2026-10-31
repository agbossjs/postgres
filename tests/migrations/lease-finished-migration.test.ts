import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresExecutionLeaseRepository } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { TestApplicationContext } from "../support/application-context.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#520: migration 0017 on a database migrated to 0016 — the leases written before it
 * (held, yielded, expired, released) are not finished: taken, renewed and released as before, and a
 * held one is finished by its holder like any other.
 */
const leasesOn = (url: string, clock: VirtualClock, instanceId: string) =>
  new PostgresExecutionLeaseRepository(
    connectionTo(url),
    clock,
    new TestApplicationContext({}, instanceId),
  );

/** A lease of instance-1 at epoch 1 on `root`, as the store wrote it before 0017. */
const leaseOf = (root: string, expiresAt: Date) => ({
  tenantId: "default",
  rootExecutionId: root,
  holderInstanceId: "instance-1",
  leaseEpoch: 1,
  expiresAt,
});

describe("migration 0017 keeps the leases written before it", () => {
  it("#520: leases taken before 0017 are not finished; taken, renewed, released and finished as before", async () => {
    const url = await freshSchema();
    await migrateWith(
      { url },
      migrationsIn(migrationsFolder({ "0017_execution_lease_finished.sql": null })),
    );
    const clock = new VirtualClock();
    const at = (length: number) => new Date(clock.now().getTime() + length);
    for (const [root, expiresAt, released, yielded] of [
      ["root-expired", at(seconds(30)), false, false],
      ["root-held", at(seconds(90)), false, false],
      ["root-yielded", at(seconds(90)), false, true],
      ["root-released", at(seconds(90)), true, false],
    ] as const)
      await onSchema(
        url,
        `INSERT INTO agboss_execution_leases (tenant_id, root_execution_id, holder_instance_id,
           lease_epoch, expires_at, released, yielded) VALUES ('default', $1, 'instance-1', 1, $2, $3, $4)`,
        [root, expiresAt, released, yielded],
      );

    const report = await migratePostgres({ url });
    await clock.advance(seconds(31));

    expect(report.applied.map((migration) => migration.version)).toEqual([17]);
    const { rows } = await onSchema(
      url,
      "SELECT root_execution_id, finished FROM agboss_execution_leases ORDER BY root_execution_id",
    );
    expect(rows).toEqual([
      { root_execution_id: "root-expired", finished: false },
      { root_execution_id: "root-held", finished: false },
      { root_execution_id: "root-released", finished: false },
      { root_execution_id: "root-yielded", finished: false },
    ]);
    const before = leasesOn(url, clock, "instance-1");
    const after = leasesOn(url, clock, "instance-2");
    expect(await after.acquire("default", "root-expired", seconds(30))).toMatchObject({
      leaseEpoch: 2,
      takenOverFrom: { holderInstanceId: "instance-1", leaseEpoch: 1 },
    });
    expect(await after.acquire("default", "root-released", seconds(30))).toMatchObject({
      leaseEpoch: 2,
    });
    expect(await after.acquire("default", "root-held", seconds(30))).toBeUndefined();
    expect(await before.renew(leaseOf("root-held", at(seconds(59))), seconds(30))).toBe(true);
    expect(await before.reclaim(leaseOf("root-yielded", at(seconds(59))), seconds(30))).toEqual(
      expect.objectContaining({ leaseEpoch: 2 }),
    );
    await before.finish(leaseOf("root-held", at(seconds(59))));
    await clock.advance(seconds(60));
    expect(await after.acquire("default", "root-held", seconds(30))).toBeUndefined();
    expect(await after.acquire("default", "root-yielded", seconds(30))).toMatchObject({
      leaseEpoch: 3,
    });
  });
});
