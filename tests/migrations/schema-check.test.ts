import { SchemaSetup } from "@agboss/core/stores";
import pg from "pg";
import { ZodError } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import {
  migratePostgres,
  PostgresSchemaMissingError,
  PostgresSchemaTooNewError,
} from "../../src/index.js";
import { migrationsIn, type MigrationFile } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { checkSchema } from "../../src/migrations/schema-check.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import { createSchema, dropSchema, onSchema, serverUrl } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { historyOf, tablesOf } from "../support/schema-dump.js";
import { closeHolders, holdSnapshot, until, validityOf } from "../support/step-index.js";

/**
 * The start-up check of `PostgresConnection.onInit` (`checkSchema`) on its own: what it decides from
 * the versions, the schema it migrates under `SchemaSetup.MigrateOnStart`, and the pool's client it
 * borrows for the read — given back as it was, or dropped when its connection was lost.
 */
const schemas: string[] = [];
const pools: pg.Pool[] = [];
const proxies: BlackholeProxy[] = [];
afterEach(async () => {
  await closeHolders();
  for (const pool of pools.splice(0)) await pool.end();
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const schema of schemas.splice(0)) await dropSchema(schema);
});

async function fresh(): Promise<{ readonly schema: string; readonly url: string }> {
  const made = await createSchema();
  schemas.push(made.schema);
  return made;
}

/** A pool of one connection to `url` (ended after the test). */
function poolOf(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pools.push(pool);
  return pool;
}

const ALL = migrationsIn();

/** The package's migrations up to `version`. */
const upTo = (version: number): readonly MigrationFile[] =>
  migrationsIn(
    migrationsFolder(
      Object.fromEntries(
        ALL.filter((file) => file.version > version).map((file) => [
          `${String(file.version).padStart(4, "0")}_${file.name}.sql`,
          null,
        ]),
      ),
    ),
  );

const rejectionOf = async (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => {
      throw new Error("resolved: it should have failed");
    },
    (error: unknown) => error,
  );

/** A lease live on the server's clock (its holder: an instance of the version being replaced). */
const liveLease = (url: string): Promise<pg.QueryResult> =>
  onSchema(
    url,
    `INSERT INTO agboss_execution_leases
       (tenant_id, root_execution_id, holder_instance_id, token, expires_at, released, finished, superseded)
     VALUES ('default', 'run-1', 'pod-old', 1, clock_timestamp() + interval '1 hour', false, false, false)`,
  );

describe("checkSchema: the versions", () => {
  it("a database at the package's migrations passes; the client goes back to the pool as it was", async () => {
    const { url } = await fresh();
    await migratePostgres({ url });
    const pool = poolOf(url);
    const borrowed = await pool.connect();
    const listeners = borrowed.listenerCount("error");
    borrowed.release();

    await checkSchema({ url, pool, schemaSetup: SchemaSetup.Check, files: ALL });

    expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual({ total: 1, idle: 1 });
    const again = await pool.connect();
    try {
      expect(again).toBe(borrowed);
      expect(again.listenerCount("error")).toBe(listeners);
    } finally {
      again.release();
    }
  });

  it("no history: PostgresSchemaMissingError, applied 0 of 35", async () => {
    const { url } = await fresh();

    const error = await rejectionOf(
      checkSchema({ url, pool: poolOf(url), schemaSetup: SchemaSetup.Check, files: ALL }),
    );

    expect(error).toBeInstanceOf(PostgresSchemaMissingError);
    expect(error).toMatchObject({ applied: 0, expected: 35 });
    expect(await tablesOf(url)).toEqual([]);
  });

  it("an older schema: PostgresSchemaMissingError with both versions, nothing migrated", async () => {
    const { url } = await fresh();
    await migrateWith({ url }, upTo(19));

    const error = await rejectionOf(
      checkSchema({ url, pool: poolOf(url), schemaSetup: SchemaSetup.Check, files: ALL }),
    );

    expect(error).toBeInstanceOf(PostgresSchemaMissingError);
    expect(error).toMatchObject({ applied: 19, expected: 35 });
    expect(await historyOf(url)).toHaveLength(19);
  });

  it("a schema one migration newer: PostgresSchemaTooNewError under either setup", async () => {
    const { url } = await fresh();
    await migratePostgres({ url });

    for (const schemaSetup of [SchemaSetup.Check, SchemaSetup.MigrateOnStart]) {
      const error = await rejectionOf(
        checkSchema({ url, pool: poolOf(url), schemaSetup, files: upTo(34) }),
      );
      expect(error).toBeInstanceOf(PostgresSchemaTooNewError);
      expect(error).toMatchObject({ applied: 35, expected: 34 });
    }
  });

  it("a history that cannot be read is the error, never read as no migrations", async () => {
    const { url } = await fresh();
    await onSchema(
      url,
      "CREATE TABLE agboss_schema_migrations (version text); INSERT INTO agboss_schema_migrations VALUES ('x')",
    );

    const error = await rejectionOf(
      checkSchema({ url, pool: poolOf(url), schemaSetup: SchemaSetup.MigrateOnStart, files: ALL }),
    );

    expect(error).toBeInstanceOf(ZodError);
  });
});

describe("checkSchema: SchemaSetup.MigrateOnStart", () => {
  it("migrates the schema it is given, not the URL's search_path; allowLiveLeases: over a live lease", async () => {
    const target = await fresh();
    await migrateWith({ url: target.url }, upTo(32));
    await liveLease(target.url);

    await checkSchema({
      // the server's URL, its search_path the server's default: the run works in `schema`
      url: serverUrl(),
      schema: target.schema,
      pool: poolOf(target.url),
      schemaSetup: SchemaSetup.MigrateOnStart,
      files: ALL,
      allowLiveLeases: true,
    });

    expect(await historyOf(target.url)).toHaveLength(35);
  });

  it("with no schema given, migrates the URL's search_path; allowLiveLeases: over a live lease", async () => {
    const { url } = await fresh();
    await migrateWith({ url }, upTo(32));
    await liveLease(url);

    await checkSchema({
      url,
      pool: poolOf(url),
      schemaSetup: SchemaSetup.MigrateOnStart,
      files: ALL,
      allowLiveLeases: true,
    });

    expect(await historyOf(url)).toHaveLength(35);
  });

  it("does not wait for the checkpoint index: the start passes while its build waits (agbossjs/agboss#962)", async () => {
    const { url } = await fresh();
    await migrateWith({ url }, upTo(34));
    await onSchema(url, "DROP INDEX checkpoints_latest_by_step");
    // an old snapshot open: a CREATE INDEX CONCURRENTLY waits for it
    await holdSnapshot(url);

    const started = checkSchema({
      url,
      pool: poolOf(url),
      schemaSetup: SchemaSetup.MigrateOnStart,
      files: ALL,
    });
    const held = new Promise<"held">((resolve) =>
      setTimeout(() => {
        resolve("held");
      }, 15_000),
    );

    expect(await Promise.race([started.then(() => "passed" as const), held])).toBe("passed");
    expect(await historyOf(url)).toHaveLength(35);
    await closeHolders();
    await until(async () => (await validityOf(url)) === true);
  });
});

describe("checkSchema: a connection lost during the read", () => {
  it("rejects the check; the pool drops the client; nothing is thrown outside the check", async () => {
    const { url } = await fresh();
    await migratePostgres({ url });
    const target = new URL(serverUrl());
    const proxy = await BlackholeProxy.start({
      host: target.hostname,
      port: Number(target.port === "" ? 5432 : target.port),
    });
    proxies.push(proxy);
    const proxied = new URL(url);
    proxied.port = String(proxy.port);
    const pool = poolOf(proxied.toString());
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    // the read's answer never arrives: the connection ends under it
    proxy.resetOn("max(version)");

    try {
      const error = await rejectionOf(
        checkSchema({ url, pool, schemaSetup: SchemaSetup.Check, files: ALL }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(String(error)).toMatch(/Connection terminated/);
      expect(uncaught).toEqual([]);
      expect(pool.totalCount).toBe(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
