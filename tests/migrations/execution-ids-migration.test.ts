import { TestStoreClock, VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresExecutionLeaseRepository } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { TestApplicationContext } from "../support/application-context.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#591: migration 0018 on a database migrated to 0017 — the trees already there are
 * known by their leases' ids (of every tenant, one row per id), so a generator that repeats one of
 * them is refused at once; a new id is kept as on a fresh schema.
 */
describe("migration 0018 keeps the ids of the trees already there", () => {
  it("#591: every lease's root id is kept once, whatever its tenant; a repeat is refused, a new id kept", async () => {
    const url = await freshSchema();
    await migrateWith(
      { url },
      migrationsIn(
        migrationsFolder({
          "0018_execution_ids.sql": null,
          "0019_execution_ids_from_outbound_calls.sql": null,
          "0020_pauses_by_tree.sql": null,
        }),
      ),
    );
    for (const [tenantId, root] of [
      ["default", "root-a"],
      ["acme", "root-a"],
      ["acme", "root-b"],
    ] as const)
      await onSchema(
        url,
        `INSERT INTO agboss_execution_leases (tenant_id, root_execution_id, holder_instance_id,
           lease_epoch, expires_at, released) VALUES ($1, $2, 'instance-1', 3, now(), true)`,
        [tenantId, root],
      );

    const report = await migratePostgres({ url });
    const leases = new PostgresExecutionLeaseRepository(
      connectionTo(url),
      new TestStoreClock(new VirtualClock()),
      new TestApplicationContext({}, "instance-1"),
    );

    expect(report.applied.map((migration) => migration.version)).toEqual([18, 19, 20]);
    const { rows } = await onSchema(
      url,
      "SELECT execution_id FROM agboss_execution_ids ORDER BY execution_id",
    );
    expect(rows).toEqual([{ execution_id: "root-a" }, { execution_id: "root-b" }]);
    for (const executionId of ["root-a", "root-b"])
      expect(await leases.saveExecutionIdIfAbsent({ executionId, tenantId: "globex" })).toBe(false);
    expect(await leases.saveExecutionIdIfAbsent({ executionId: "root-c", tenantId: "acme" })).toBe(
      true,
    );
  });
});
