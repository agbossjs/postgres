import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { StoreClock, StoreTimeSource } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { hours } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresLiveLeasesError } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { TestApplicationContext } from "../support/application-context.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#1117: migration 0034 moves the cancel marks of 0032's table onto the lease rows
 * (`cancel_requested_at`; a tree with no row gets a seed row, token 0, released) and drops the
 * table. A mark the row already has stays; a run again changes nothing; the live-lease guard
 * (agbossjs/agboss#1104) refuses while a lease is live.
 */
const BEFORE_0034 = { "0034_cancel_mark_on_lease_row.sql": null };

async function schemaAt0033(): Promise<string> {
  const url = await freshSchema();
  await migrateWith({ url }, migrationsIn(migrationsFolder(BEFORE_0034)));
  return url;
}

async function leaseRowsOf(url: string): Promise<readonly unknown[]> {
  const { rows } = await onSchema(
    url,
    `SELECT root_execution_id AS root, token, released, holder_instance_id AS holder,
       cancel_requested_at IS NOT NULL AS marked FROM agboss_execution_leases ORDER BY 1`,
  );
  return rows as readonly unknown[];
}

describe("migration 0034: the cancel mark lives on the lease row (#1117)", () => {
  it("every mark moves onto its tree's row; a tree with no row gets a seed row; the table is dropped", async () => {
    const url = await schemaAt0033();
    await onSchema(
      url,
      `INSERT INTO agboss_execution_leases (tenant_id, root_execution_id, holder_instance_id, token,
         expires_at, released, finished) VALUES ('default', 'with-row', 'pod-a', 3, now() - interval '1 hour', true, true)`,
    );
    await onSchema(
      url,
      `INSERT INTO agboss_execution_cancel_requests VALUES ('default', 'with-row', now()),
         ('default', 'no-row', now())`,
    );

    const report = await migratePostgres({ url });

    expect(report.applied.map((file) => file.version)).toEqual([34]);
    expect(await leaseRowsOf(url)).toEqual([
      { root: "no-row", token: 0, released: true, holder: "", marked: true },
      { root: "with-row", token: 3, released: true, holder: "pod-a", marked: true },
    ]);
    const dropped = await onSchema(
      url,
      "SELECT to_regclass('agboss_execution_cancel_requests') AS t",
    );
    expect(dropped.rows).toEqual([{ t: null }]);
  });

  it("a tree moved by the migration, cancelled before its first acquire: the first acquire is token 1, no takeover, the mark stays", async () => {
    const url = await schemaAt0033();
    await onSchema(
      url,
      "INSERT INTO agboss_execution_cancel_requests VALUES ('default', 'seeded', now())",
    );
    await migratePostgres({ url });
    const leases = new PostgresExecutionLeaseRepository(
      connectionTo(url),
      new StoreClock(StoreTimeSource.Test, new VirtualClock()),
      new TestApplicationContext({}),
    );

    const taken = await leases.acquire("default", "seeded", hours(1));

    expect(taken).toMatchObject({ token: 1 });
    expect(taken?.takenOverFrom).toBeUndefined();
    expect(await leaseRowsOf(url)).toEqual([
      { root: "seeded", token: 1, released: false, holder: expect.any(String), marked: true },
    ]);
  });

  it("run again, the rows are as they were; the guard refuses a live lease", async () => {
    const url = await schemaAt0033();
    await onSchema(
      url,
      `INSERT INTO agboss_execution_leases (tenant_id, root_execution_id, holder_instance_id, token,
         expires_at, released) VALUES ('default', 'live', 'pod-a', 1, clock_timestamp() + interval '1 hour', false)`,
    );

    const refused = await migratePostgres({ url }).catch((error: unknown) => error);
    const allowed = await migratePostgres({ url, allowLiveLeases: true });
    const again = await migratePostgres({ url });

    expect(refused).toBeInstanceOf(PostgresLiveLeasesError);
    expect(allowed.applied.map((file) => file.version)).toEqual([34]);
    expect(again.applied).toEqual([]);
  });
});
