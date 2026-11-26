import { describe, expect, it } from "vitest";
import {
  migratePostgres,
  PostgresConnection,
  PostgresSchemaMissingError,
  PostgresSchemaTooNewError,
  SchemaSetup,
} from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { freshSchema, onSchema, serverUrl, urlOnSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { historyOf } from "../support/schema-dump.js";
import { revealing } from "../support/application-context.js";

const rejectionOf = async (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => {
      throw new Error("resolved: it should have failed");
    },
    (error: unknown) => error,
  );

/** A connection of a test, ended after `use`. */
async function withConnection<TResult>(
  connection: PostgresConnection,
  use: (connection: PostgresConnection) => Promise<TResult>,
): Promise<TResult> {
  try {
    return await use(connection);
  } finally {
    await connection.onDestroy();
  }
}

describe("PostgresConnection: one pool per application instance", () => {
  it("is built from the driver's resolved settings: url, poolSize", async () => {
    const url = await freshSchema();
    const resolved = { kind: "postgres", url: revealing(url), poolSize: 3 };

    await withConnection(new PostgresConnection(resolved), async (connection) => {
      await connection.ping();
      expect(connection.pool.options.max).toBe(3);
      expect(await connection.schema()).toMatch(/^t_/);
    });
  });

  it("its pool has 10 connections by default", async () => {
    await withConnection(new PostgresConnection({ url: serverUrl() }), async (connection) => {
      expect(connection.pool.options.max).toBe(10);
    });
  });

  it("ping() is one SELECT 1; it rejects when the database does not answer", async () => {
    await withConnection(
      new PostgresConnection({ url: "postgres://postgres:pw@127.0.0.1:1/postgres" }),
      async (connection) => {
        await expect(connection.ping()).rejects.toThrow();
      },
    );
  });

  it("onDestroy ends the pool once: a second call does nothing, a ping after it rejects", async () => {
    const connection = new PostgresConnection({ url: serverUrl() });
    await connection.ping();

    await connection.onDestroy();
    await connection.onDestroy();

    expect(connection.pool.ended).toBe(true);
    await expect(connection.ping()).rejects.toThrow(/after calling end/);
  });

  it("schema(): no existing schema on the search_path rejects — and is asked again next time", async () => {
    const schema = "t_created_later";
    const url = urlOnSchema(serverUrl(), schema);
    await onSchema(serverUrl(), `DROP SCHEMA IF EXISTS ${schema}`);

    await withConnection(new PostgresConnection({ url }), async (connection) => {
      await expect(connection.schema()).rejects.toThrow("names no existing schema");
      await onSchema(serverUrl(), `CREATE SCHEMA ${schema}`);
      try {
        expect(await connection.schema()).toBe(schema);
      } finally {
        await onSchema(serverUrl(), `DROP SCHEMA ${schema}`);
      }
    });
  });
});

describe("PostgresConnection.onInit: the schema check at start", () => {
  it("a migrated database starts", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });

    await withConnection(new PostgresConnection({ url }), async (connection) => {
      await expect(connection.onInit()).resolves.toBeUndefined();
    });
  });

  it("AC1: SchemaSetup.Check (the default) refuses a database without the migrations — PostgresSchemaMissingError, naming the command", async () => {
    const url = await freshSchema();

    const error = await withConnection(new PostgresConnection({ url }), (connection) =>
      rejectionOf(connection.onInit()),
    );

    expect(error).toBeInstanceOf(PostgresSchemaMissingError);
    expect(error).toMatchObject({ code: "postgres.schema-missing", applied: 0, expected: 1 });
    expect(String(error)).toContain("run `npx agboss-postgres migrate` with POSTGRES_URL set");
    expect(String(error)).not.toContain("--url");
    expect(String(error)).toContain("PostgresDriver schemaSetup: SchemaSetup.MigrateOnStart");
  });

  it("AC1: SchemaSetup.MigrateOnStart (the driver's schemaSetup): a missing schema is migrated at start", async () => {
    const url = await freshSchema();
    const resolved = {
      kind: "postgres",
      url: revealing(url),
      schemaSetup: SchemaSetup.MigrateOnStart,
    };

    await withConnection(new PostgresConnection(resolved), (connection) => connection.onInit());

    expect(await historyOf(url)).toHaveLength(1);
  });

  it("AC1: SchemaSetup.MigrateOnStart: two instances starting at once migrate it once", async () => {
    const url = await freshSchema();
    const schemaSetup = SchemaSetup.MigrateOnStart;
    const instances = [1, 2].map(() => new PostgresConnection({ url, schemaSetup, poolSize: 1 }));

    await Promise.all(instances.map((connection) => connection.onInit()));
    await Promise.all(instances.map((connection) => connection.onDestroy()));

    expect(await historyOf(url)).toHaveLength(1);
  });

  it("AC1: a schema a newer package migrated fails with PostgresSchemaTooNewError, under either setup", async () => {
    const url = await freshSchema();
    await migrateWith(
      { url },
      migrationsIn(migrationsFolder({ "0002_later.sql": "CREATE TABLE later (id integer);" })),
    );

    for (const schemaSetup of [SchemaSetup.Check, SchemaSetup.MigrateOnStart]) {
      const error = await withConnection(
        new PostgresConnection({ url, schemaSetup }),
        (connection) => rejectionOf(connection.onInit()),
      );
      expect(error).toBeInstanceOf(PostgresSchemaTooNewError);
      expect(error).toMatchObject({ applied: 2, expected: 1 });
      expect(String(error)).toContain("the migrations are not rolled back");
    }
  });

  it("AC4: a start whose check fails ends the pool — no connection left open", async () => {
    const url = await freshSchema();
    const connection = new PostgresConnection({ url });

    await expect(connection.onInit()).rejects.toBeInstanceOf(PostgresSchemaMissingError);

    expect(connection.pool.ended).toBe(true);
    expect(connection.pool.totalCount).toBe(0);
  });

  it("an unreachable database fails the start", async () => {
    await withConnection(
      new PostgresConnection({ url: "postgres://postgres:pw@127.0.0.1:1/postgres" }),
      async (connection) => {
        await expect(connection.onInit()).rejects.toThrow();
      },
    );
  });
});
