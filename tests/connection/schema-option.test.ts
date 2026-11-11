/**
 * agbossjs/agboss#891 AC3: `PostgresConnectionSettings.schema` (`postgresSchema`) and
 * `migratePostgres({ schema })` put an application in a schema of its own, so two applications on
 * one database are isolated — without changing a migration file, so the checksums the history keeps
 * stay those of every earlier release.
 */
import { StoreClock, StoreTimeSource } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEMA,
  migratePostgres,
  PostgresConnection,
  PostgresExecutionLeaseRepository,
  PostgresMigrationChangedError,
  PostgresSettingsError,
} from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { quotedIdentifier } from "../../src/connection/settings.js";
import { revealing, TestApplicationContext } from "../support/application-context.js";
import { newSchemaName, onServer, serverUrl } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";

const made: string[] = [];

/** A schema name of this run (`app_a_<hex>`), dropped after the file. */
function schemaNamed(prefix: string): string {
  const schema = `${prefix}${newSchemaName().slice(1)}`;
  made.push(schema);
  return schema;
}

afterAll(async () => {
  for (const schema of made)
    await onServer(`DROP SCHEMA IF EXISTS ${quotedIdentifier(schema)} CASCADE`);
});

/** `use` on a connection to `schema` of the test server, ended after it. */
async function inSchema<TResult>(
  schema: string,
  use: (connection: PostgresConnection) => Promise<TResult>,
): Promise<TResult> {
  const connection = new PostgresConnection({ url: serverUrl(), schema, poolSize: 2 });
  try {
    return await use(connection);
  } finally {
    await connection.onDestroy();
  }
}

/** The history's checksums of `schema`, by version. */
const checksumsOf = (schema: string): Promise<readonly string[]> =>
  inSchema(schema, async (connection) => {
    const { rows } = await connection.pool.query<{ version: number; checksum: string }>(
      "SELECT version, checksum FROM agboss_schema_migrations ORDER BY version",
    );
    return rows.map((row) => `${String(row.version)}:${row.checksum}`);
  });

const leasesIn = (connection: PostgresConnection): PostgresExecutionLeaseRepository =>
  new PostgresExecutionLeaseRepository(
    connection,
    new StoreClock(StoreTimeSource.Test, new VirtualClock()),
    new TestApplicationContext({}),
  );

describe("agbossjs/agboss#891 AC3: one schema per application on one database", () => {
  const appA = schemaNamed("app_a");
  const appB = schemaNamed("app_b");

  it("AC3: migratePostgres({ schema }) creates the schema and migrates it, the files' checksums unchanged", async () => {
    const report = await migratePostgres({ url: serverUrl(), schema: appA });
    await migratePostgres({ url: serverUrl(), schema: appB });

    const files = migrationsIn().map((file) => `${String(file.version)}:${file.checksum}`);
    expect(report.schema).toBe(appA);
    expect(report.applied).toHaveLength(files.length);
    expect(await checksumsOf(appA)).toEqual(files);
    expect(await checksumsOf(appB)).toEqual(files);
  });

  it("AC3: both start under SchemaSetup.Check, each in its own schema", async () => {
    for (const schema of [appA, appB])
      await inSchema(schema, async (connection) => {
        await connection.onInit();
        expect(await connection.schema()).toBe(schema);
      });
  });

  it("AC3: what one application writes the other never sees", async () => {
    const identity = { tenantId: "default", executionId: "e-891-isolated" };

    const first = await inSchema(appA, (connection) =>
      leasesIn(connection).claimExecutionId(identity),
    );
    const again = await inSchema(appA, (connection) =>
      leasesIn(connection).claimExecutionId(identity),
    );
    const other = await inSchema(appB, (connection) =>
      leasesIn(connection).claimExecutionId(identity),
    );

    expect([first, again, other]).toEqual([true, false, true]);
  });

  it("AC3: the environment's postgresSchema is the connection's", async () => {
    const application = new TestApplicationContext({
      postgresUrl: revealing(serverUrl()),
      postgresSchema: appB,
    });
    const connection = new PostgresConnection(application);
    try {
      expect(await connection.schema()).toBe(appB);
    } finally {
      await connection.onDestroy();
    }
  });

  it("AC3: an edited migration file still fails a run on the schema — PostgresMigrationChangedError", async () => {
    const changed = migrationsFolder({ "0001_execution_leases.sql": "SELECT 1;" });

    await expect(
      migrateWith({ url: serverUrl(), schema: appA }, migrationsIn(changed)),
    ).rejects.toBeInstanceOf(PostgresMigrationChangedError);
  });

  it.each([
    ["", /the schema name is empty/],
    ['app"; DROP SCHEMA public CASCADE; --', /plain lowercase identifier/],
    ["we ird", /plain lowercase identifier/],
    ["App_A", /plain lowercase identifier/],
    ["1app", /plain lowercase identifier/],
    ["a\u0000b", /plain lowercase identifier/],
    ["s".repeat(64), /plain lowercase identifier/],
  ])(
    "AC3: the schema %j is refused with PostgresSettingsError before any SQL",
    async (schema, message) => {
      expect(() => new PostgresConnection({ url: serverUrl(), schema })).toThrow(
        PostgresSettingsError,
      );
      expect(() => new PostgresConnection({ url: serverUrl(), schema })).toThrow(message);
      await expect(migratePostgres({ url: serverUrl(), schema })).rejects.toThrow(message);
    },
  );

  it("AC3: a name of 63 characters is the longest accepted", async () => {
    const longest = schemaNamed(`l${"x".repeat(49)}`);

    expect(longest).toHaveLength(63);
    await migratePostgres({ url: serverUrl(), schema: longest });
    await inSchema(longest, async (connection) => {
      await connection.onInit();
      expect(await connection.schema()).toBe(longest);
    });
  });

  it("AC3: DEFAULT_SCHEMA is PostgreSQL's own", () => {
    expect(DEFAULT_SCHEMA).toBe("public");
  });
});
