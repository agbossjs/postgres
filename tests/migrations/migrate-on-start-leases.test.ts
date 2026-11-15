import { SchemaSetup } from "@agboss/core/stores";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresConnection, PostgresLiveLeasesError } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith, migratePostgres } from "../../src/migrations/migrate.js";
import { checkSchema } from "../../src/migrations/schema-check.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { historyOf } from "../support/schema-dump.js";

/**
 * agbossjs/agboss#1104 (ADR-0034): no rolling upgrade across a schema change, `MigrateOnStart`
 * included. A start that has migrations to apply waits for the live execution leases to lapse (the
 * old instance stopped: its leases do) and fails with `PostgresLiveLeasesError` while one is live (the
 * old instance still renewing); `allowLiveLeases` keeps the override. Nothing to apply: no look.
 */
const FILES = migrationsIn();
const BEFORE_0033 = { "0033_pause_channel_generated.sql": null };
const SHORT = { maxMs: 600, pollMs: 100 };
const pools: pg.Pool[] = [];

afterAll(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

/** A database at 0032 and a lease of `holder` expiring in `ms` milliseconds on the server's clock. */
async function schemaWithLease(ms: number): Promise<string> {
  const url = await freshSchema();
  await migrateWith({ url }, migrationsIn(migrationsFolder(BEFORE_0033)));
  await onSchema(
    url,
    `INSERT INTO agboss_execution_leases
       (tenant_id, root_execution_id, holder_instance_id, token, expires_at, released)
     VALUES ('default', 'run-1', 'old-pod', 1, clock_timestamp() + ($1 || ' milliseconds')::interval, false)`,
    [String(ms)],
  );
  return url;
}

const startOf = (url: string, extra: object = {}): Promise<void> => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  pools.push(pool);
  return checkSchema({
    url,
    pool,
    schemaSetup: SchemaSetup.MigrateOnStart,
    files: FILES,
    leaseWait: SHORT,
    ...extra,
  });
};

describe("#1104: a start that migrates and the live leases", () => {
  it("a single instance upgraded: its stopped pod's lease lapses, the start waits, then migrates", async () => {
    const url = await schemaWithLease(1_500);

    await startOf(url, { leaseWait: { maxMs: 20_000, pollMs: 200 } });

    expect((await historyOf(url)).at(-1)).toBe("33:pause_channel_generated");
  });

  it("a rolling restart, the old pod alive: refused with PostgresLiveLeasesError, nothing applied", async () => {
    const url = await schemaWithLease(3_600_000);

    const error = await startOf(url).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PostgresLiveLeasesError);
    expect(error).toMatchObject({ code: "postgres.live-leases", count: 1, holders: ["old-pod"] });
    expect((await historyOf(url)).at(-1)).toBe("32:execution_cancel_requests");
  });

  it("allowLiveLeases: the override migrates over the live lease at once", async () => {
    const url = await schemaWithLease(3_600_000);
    const connection = new PostgresConnection({
      url,
      schemaSetup: SchemaSetup.MigrateOnStart,
      allowLiveLeases: true,
    });

    await connection.onInit();
    await connection.onDestroy();

    expect((await historyOf(url)).at(-1)).toBe("33:pause_channel_generated");
  });

  it("no migration pending: a restart with a live lease starts at once", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });
    await onSchema(
      url,
      `INSERT INTO agboss_execution_leases
         (tenant_id, root_execution_id, holder_instance_id, token, expires_at, released)
       VALUES ('default', 'run-1', 'pod', 1, clock_timestamp() + interval '1 hour', false)`,
    );

    await expect(startOf(url, { leaseWait: { maxMs: 1, pollMs: 1 } })).resolves.toBeUndefined();
  });

  it("a database with no migrations (the first start) has no leases to wait for", async () => {
    const url = await freshSchema();

    await startOf(url);

    expect((await historyOf(url)).at(-1)).toBe("33:pause_channel_generated");
  });
});
