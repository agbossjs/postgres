import pg from "pg";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migratePostgres, PostgresStepIndexError } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { createSchema as createSchemaOf, migrateWith } from "../../src/migrations/migrate.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import {
  createSchema,
  dropSchema,
  newSchemaName,
  onSchema,
  serverUrl,
  urlOnSchema,
} from "../support/database.js";
import { emptyFolder } from "../support/migration-folders.js";
import { historyOf, tablesOf } from "../support/schema-dump.js";
import { until, validityOf } from "../support/step-index.js";

/**
 * One migration run (`migrateWith`) beyond what it applies: the schema it creates when another run
 * creates it too, the search_path each file runs under, its report when the index builds in the
 * background, the step index failing for another reason than the build, its session lost, and its
 * pool ended.
 */
const schemas: string[] = [];
const proxies: BlackholeProxy[] = [];
afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const schema of schemas.splice(0)) await dropSchema(schema);
});

async function fresh(): Promise<{ readonly schema: string; readonly url: string }> {
  const made = await createSchema();
  schemas.push(made.schema);
  return made;
}

const rejectionOf = async (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => {
      throw new Error("resolved: it should have failed");
    },
    (error: unknown) => error,
  );

/** A database error as `pg` gives one: an `Error` with PostgreSQL's code. */
const databaseError = (code: string): Error => Object.assign(new Error(`code ${code}`), { code });

describe("createSchema: the schema a run is given", () => {
  it("another run creating it at the same moment is no failure: either of PostgreSQL's two codes", async () => {
    for (const code of ["23505", "42P06"]) {
      const statements = { query: () => Promise.reject(databaseError(code)) };
      await expect(createSchemaOf(statements, "s")).resolves.toBeUndefined();
    }
  });

  it("any other failure is the run's: any other code", async () => {
    const denied = databaseError("42501");
    await expect(createSchemaOf({ query: () => Promise.reject(denied) }, "s")).rejects.toBe(denied);
  });

  it("a run whose schema another session creates under it migrates it all the same", async () => {
    const schema = newSchemaName();
    schemas.push(schema);
    const creator = new pg.Client({ connectionString: serverUrl() });
    await creator.connect();
    try {
      // the other session's schema is not committed: the run's CREATE waits for it, then finds
      // the name taken (unique_violation)
      await creator.query("BEGIN");
      await creator.query(`CREATE SCHEMA ${schema}`);
      const run = migrateWith({ url: serverUrl(), schema }, migrationsIn());
      await until(async () => {
        const { rows } = await onSchema(
          serverUrl(),
          `SELECT 1 FROM pg_stat_activity
            WHERE query LIKE 'CREATE SCHEMA IF NOT EXISTS%' AND query LIKE $1 AND wait_event_type = 'Lock'`,
          [`%${schema}%`],
        );
        return rows.length > 0;
      });
      await creator.query("COMMIT");

      expect((await run).applied).toHaveLength(1);
    } finally {
      await creator.end();
    }
    expect(await historyOf(urlOnSchema(serverUrl(), schema))).toHaveLength(1);
  });
});

describe("migrateWith: one run", () => {
  it("each file runs in the given schema, whatever search_path a file before it set", async () => {
    const target = await fresh();
    const elsewhere = await fresh();
    const folder = emptyFolder();
    // a session-level SET persists after its transaction commits
    writeFileSync(
      join(folder, "0001_moves_the_path.sql"),
      `SET search_path TO ${elsewhere.schema}, ${target.schema}; CREATE TABLE first_table (id integer);`,
    );
    writeFileSync(join(folder, "0002_after_it.sql"), "CREATE TABLE second_table (id integer);");

    await migrateWith({ url: target.url, schema: target.schema }, migrationsIn(folder));

    expect(await tablesOf(elsewhere.url)).toEqual(["first_table"]);
    expect(await tablesOf(target.url)).toContain("second_table");
  });

  it("a run that builds the index in the background reports no stepIndex", async () => {
    const { url } = await fresh();

    const report = await migrateWith({ url }, migrationsIn(), true);

    expect(Object.keys(report)).not.toContain("stepIndex");
    expect(report.applied).toHaveLength(1);
    await until(async () => (await validityOf(url)) === true);
  });

  it("a step index that fails before its build (the signal) is PostgresStepIndexError with the report", async () => {
    const { url } = await fresh();
    await migratePostgres({ url });
    const stopped = new Error("stopped at the index step");
    const controller = new AbortController();
    let checks = 0;
    // the run checks its signal before it connects, under the lock, then (nothing pending) at the index step
    Object.defineProperty(controller.signal, "throwIfAborted", {
      value: () => {
        checks += 1;
        if (checks === 3) throw stopped;
      },
    });

    const error = await rejectionOf(
      migrateWith({ url, signal: controller.signal }, migrationsIn()),
    );

    expect(error).toBeInstanceOf(PostgresStepIndexError);
    expect(error).toMatchObject({ report: { applied: [], version: 1 }, invalidIndexLeft: false });
    expect(error instanceof Error ? error.cause : undefined).toBe(stopped);
  });

  it("ends its pool: no session of the run stays open", async () => {
    const { url } = await fresh();
    const named = new URL(url);
    const application = `m_${newSchemaName()}`;
    named.searchParams.set("application_name", application);

    await migrateWith({ url: named.toString() }, migrationsIn());

    // its sessions are closed when the run returns; the server lets them go within moments (an
    // idle session of a pool not ended would stay 10 s, the pool's idle timeout)
    let open = -1;
    for (let polls = 0; polls < 20 && open !== 0; polls += 1) {
      if (polls > 0) await new Promise((resolve) => setTimeout(resolve, 100));
      const { rows } = await onSchema(
        serverUrl(),
        "SELECT 1 FROM pg_stat_activity WHERE application_name = $1",
        [application],
      );
      open = rows.length;
    }
    expect(open).toBe(0);
  });

  it("a session lost under the run rejects it; nothing is thrown outside the run", async () => {
    const { url } = await fresh();
    const target = new URL(serverUrl());
    const proxy = await BlackholeProxy.start({
      host: target.hostname,
      port: Number(target.port === "" ? 5432 : target.port),
    });
    proxies.push(proxy);
    const proxied = new URL(url);
    proxied.port = String(proxy.port);
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    // the lock is granted, its answer never arrives: the session ends under the run
    proxy.resetOn("pg_advisory_lock");

    try {
      const error = await rejectionOf(migrateWith({ url: proxied.toString() }, migrationsIn()));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(String(error)).toMatch(/Connection terminated/);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
