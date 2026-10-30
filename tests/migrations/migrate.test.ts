import { describe, expect, it } from "vitest";
import {
  migratePostgres,
  PostgresMigrationChangedError,
  PostgresSchemaTooNewError,
} from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { MIGRATION_LOCK_KEY, migrateWith } from "../../src/migrations/migrate.js";
import { freshSchema, onSchema, serverUrl, urlOnSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { historyOf, schemaDumpOf, tablesOf } from "../support/schema-dump.js";

const PACKAGE_MIGRATIONS = [
  "1:execution_leases",
  "2:execution_records",
  "3:execution_trees",
  "4:paused_executions",
  "5:child_execution_queue",
  "6:fenced_effects",
];

const rejectionOf = async (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => {
      throw new Error("resolved: it should have failed");
    },
    (error: unknown) => error,
  );

describe("migratePostgres (AC5)", () => {
  it("AC5: a second run changes nothing", async () => {
    const url = await freshSchema();

    const first = await migratePostgres({ url });
    const dumped = await schemaDumpOf(url);
    const second = await migratePostgres({ url });

    expect(first.applied.map((m) => `${String(m.version)}:${m.name}`)).toEqual(PACKAGE_MIGRATIONS);
    expect(first.version).toBe(6);
    expect(first.checkpointMigrations).toBeGreaterThan(0);
    expect(second).toEqual({ ...first, applied: [], checkpointMigrations: 0 });
    expect(await schemaDumpOf(url)).toBe(dumped);
    expect(await historyOf(url)).toEqual(PACKAGE_MIGRATIONS);
  });

  it("creates every store's tables and LangGraph's checkpoint tables in the URL's schema", async () => {
    const url = await freshSchema();

    const report = await migratePostgres({ url });

    expect(report.schema).toMatch(/^t_[0-9a-f]{12}$/);
    expect(await tablesOf(url)).toEqual([
      "agboss_child_execution_queue",
      "agboss_config_versions",
      "agboss_execution_leases",
      "agboss_execution_records",
      "agboss_execution_scores",
      "agboss_execution_summaries",
      "agboss_execution_tree_keys",
      "agboss_fenced_effect_marks",
      "agboss_fenced_effect_results",
      "agboss_pause_answers",
      "agboss_paused_executions",
      "agboss_pauses",
      "agboss_schema_migrations",
      "agboss_threads",
      "checkpoint_blobs",
      "checkpoint_migrations",
      "checkpoint_writes",
      "checkpoints",
    ]);
  });

  it("concurrent runs serialize: one applies every migration, the others nothing", async () => {
    const url = await freshSchema();

    const reports = await Promise.all([1, 2, 3].map(() => migratePostgres({ url })));

    const applied = reports.map((report) => report.applied.length).sort();
    expect(applied).toEqual([0, 0, 6]);
    expect(await historyOf(url)).toEqual(PACKAGE_MIGRATIONS);
  });

  it("a run waits for another one holding the schema's lock", async () => {
    const url = await freshSchema();
    const pg = await import("pg");
    const holder = new pg.default.Client({ connectionString: url });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1, hashtext(current_schema()))", [
      MIGRATION_LOCK_KEY,
    ]);
    let isDone = false;

    const run = migratePostgres({ url }).then((report) => {
      isDone = true;
      return report;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const doneWhileLocked = isDone;
    await holder.query("SELECT pg_advisory_unlock($1, hashtext(current_schema()))", [
      MIGRATION_LOCK_KEY,
    ]);
    await holder.end();

    expect(doneWhileLocked).toBe(false);
    expect((await run).applied).toHaveLength(6);
  });

  it("a migration changed after it was applied fails the run, and nothing more is applied", async () => {
    const url = await freshSchema();
    await migrateWith({ url }, migrationsIn(migrationsFolder({ "0006_fenced_effects.sql": null })));
    const changed = migrationsFolder({
      "0002_execution_records.sql": "CREATE TABLE edited_after_release (id integer);",
    });

    const error = await rejectionOf(migrateWith({ url }, migrationsIn(changed)));

    expect(error).toBeInstanceOf(PostgresMigrationChangedError);
    expect(error).toMatchObject({
      code: "postgres.migration-changed",
      version: 2,
      migration: "execution_records",
    });
    expect(await historyOf(url)).toEqual(PACKAGE_MIGRATIONS.slice(0, 5));
    expect(await tablesOf(url)).not.toContain("agboss_fenced_effect_marks");
  });

  it("an applied migration renamed in the package fails the run", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });
    const sql = migrationsIn()[0]?.sql ?? "";
    const renamed = migrationsFolder({
      "0001_execution_leases.sql": null,
      "0001_leases.sql": sql,
    });

    await expect(migrateWith({ url }, migrationsIn(renamed))).rejects.toBeInstanceOf(
      PostgresMigrationChangedError,
    );
  });

  it("a database a newer package migrated fails the run: PostgresSchemaTooNewError", async () => {
    const url = await freshSchema();
    const newer = migrationsFolder({
      "0007_later_feature.sql": "CREATE TABLE later (id integer);",
    });
    await migrateWith({ url }, migrationsIn(newer));

    const error = await rejectionOf(migratePostgres({ url }));

    expect(error).toBeInstanceOf(PostgresSchemaTooNewError);
    expect(error).toMatchObject({ code: "postgres.schema-too-new", applied: 7, expected: 6 });
  });

  it("a failing migration is rolled back alone: the ones before it stay applied", async () => {
    const url = await freshSchema();
    const broken = migrationsFolder({
      "0007_broken.sql": "CREATE TABLE half_made (id integer); SELECT no_such_function();",
    });

    await expect(migrateWith({ url }, migrationsIn(broken))).rejects.toThrow(/no_such_function/);

    expect(await historyOf(url)).toEqual(PACKAGE_MIGRATIONS);
    expect(await tablesOf(url)).not.toContain("half_made");
  });

  it("the migrations of a run are applied after the ones already there", async () => {
    const url = await freshSchema();
    await migrateWith({ url }, migrationsIn(migrationsFolder({ "0006_fenced_effects.sql": null })));

    const report = await migratePostgres({ url });

    expect(report.applied).toEqual([{ version: 6, name: "fenced_effects" }]);
    expect(report.checkpointMigrations).toBe(0);
  });

  it("an aborted signal stops the run before it connects", async () => {
    const url = await freshSchema();
    const controller = new AbortController();
    controller.abort(new Error("the Job was stopped"));

    await expect(migratePostgres({ url, signal: controller.signal })).rejects.toThrow(
      "the Job was stopped",
    );
    expect(await tablesOf(url)).toEqual([]);
  });

  it("a signal aborted during the run stops it before its next migration", async () => {
    const url = await freshSchema();
    const controller = new AbortController();
    let checks = 0;
    // the run checks its signal before it connects, under the lock, then before each migration
    Object.defineProperty(controller.signal, "throwIfAborted", {
      value: () => {
        checks += 1;
        if (checks === 5) throw new Error("stopped after two migrations");
      },
    });

    await expect(migratePostgres({ url, signal: controller.signal })).rejects.toThrow(
      "stopped after two migrations",
    );
    expect(await historyOf(url)).toEqual(PACKAGE_MIGRATIONS.slice(0, 2));
  });

  it("a search_path naming no existing schema fails the run, saying so", async () => {
    const url = urlOnSchema(serverUrl(), "t_no_such_schema");

    await expect(migratePostgres({ url })).rejects.toThrow(
      "the connection's search_path names no existing schema",
    );
  });

  it("an unreachable database rejects the run", async () => {
    await expect(
      migratePostgres({ url: "postgres://postgres:pw@127.0.0.1:1/postgres" }),
    ).rejects.toThrow();
  });

  it("the history is the package's: every version, name and checksum", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });

    const { rows } = await onSchema(
      url,
      "SELECT version, name, checksum FROM agboss_schema_migrations ORDER BY version",
    );

    expect(rows).toEqual(
      migrationsIn().map(({ version, name, checksum }) => ({ version, name, checksum })),
    );
  });
});
