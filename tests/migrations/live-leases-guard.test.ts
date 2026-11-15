import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresLiveLeasesError } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { historyOf } from "../support/schema-dump.js";

/**
 * agbossjs/agboss#1104 (ADR-0034): a schema upgrade is stop the old version → migrate → deploy. The
 * run that would apply a migration refuses while an execution lease is live on the server's clock
 * (not released, finished or superseded, `expires_at` after the server's now): its holder is an
 * instance of the old version. An idle old instance holds no lease — the guard cannot see it.
 */
const BEFORE_0033 = { "0033_pause_channel_generated.sql": null };

/** The migrations after 0013 left out: a database migrated by the 0.1.0 package. */
const AFTER_0013 = Object.fromEntries(
  migrationsIn()
    .filter((file) => file.version > 13)
    .map((file) => [`${String(file.version).padStart(4, "0")}_${file.name}.sql`, null]),
);

/** A database at 0032 (a release before this one). */
async function schemaAt0032(): Promise<string> {
  const url = await freshSchema();
  await migrateWith({ url }, migrationsIn(migrationsFolder(BEFORE_0033)));
  return url;
}

/** One lease row; `overrides` set its columns (`expires_at` is an SQL expression). */
async function leaseOf(
  url: string,
  root: string,
  holder: string,
  state: { released?: boolean; finished?: boolean; superseded?: boolean; expires?: string } = {},
): Promise<void> {
  await onSchema(
    url,
    `INSERT INTO agboss_execution_leases
       (tenant_id, root_execution_id, holder_instance_id, token, expires_at, released, finished, superseded)
     VALUES ('default', $1, $2, 1, ${state.expires ?? "clock_timestamp() + interval '1 hour'"}, $3, $4, $5)`,
    [root, holder, state.released ?? false, state.finished ?? false, state.superseded ?? false],
  );
}

describe("#1104: migrate refuses while an execution lease is live", () => {
  it("AC1: a live lease and a pending migration: PostgresLiveLeasesError, nothing applied", async () => {
    const url = await schemaAt0032();
    await leaseOf(url, "run-1", "pod-a");
    await leaseOf(url, "run-2", "pod-b");
    await leaseOf(url, "run-3", "pod-a");

    const error = await migratePostgres({ url }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(PostgresLiveLeasesError);
    expect(error).toMatchObject({
      code: "postgres.live-leases",
      count: 3,
      holders: ["pod-a", "pod-b"],
    });
    expect(String(Reflect.get(error as Error, "message"))).toMatch(/3 live execution lease/);
    expect(String(Reflect.get(error as Error, "message"))).toMatch(/allowLiveLeases/);
    expect((await historyOf(url)).at(-1)).toBe("32:execution_cancel_requests");
  });

  it("AC1: the samples are at most 5 holders, the count is all of them", async () => {
    const url = await schemaAt0032();
    for (let at = 0; at < 8; at += 1) await leaseOf(url, `run-${String(at)}`, `pod-${String(at)}`);

    const error = await migratePostgres({ url }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ count: 8 });
    expect(Reflect.get(error as Error, "holders")).toHaveLength(5);
  });

  it("AC2: only a live lease counts: released, finished, superseded and expired ones do not", async () => {
    const url = await schemaAt0032();
    await leaseOf(url, "released", "pod-a", { released: true });
    await leaseOf(url, "finished", "pod-a", { finished: true });
    await leaseOf(url, "superseded", "pod-a", { superseded: true });
    await leaseOf(url, "expired", "pod-a", { expires: "clock_timestamp() - interval '1 second'" });

    const report = await migratePostgres({ url });

    expect(report.applied.map((migration) => migration.version)).toEqual([33]);
  });

  it("AC3: allowLiveLeases: true migrates over a live lease", async () => {
    const url = await schemaAt0032();
    await leaseOf(url, "run-1", "pod-a");

    const report = await migratePostgres({ url, allowLiveLeases: true });

    expect(report.applied.map((migration) => migration.version)).toEqual([33]);
  });

  it("AC4: nothing to apply is a no-op with live leases", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });
    await leaseOf(url, "run-1", "pod-a");

    const report = await migratePostgres({ url });

    expect(report.applied).toEqual([]);
  });

  it("AC6: a database of the 0.1.0 package (0013: no finished or superseded column) is checked too", async () => {
    const url = await freshSchema();
    await migrateWith({ url }, migrationsIn(migrationsFolder(AFTER_0013)));
    await onSchema(
      url,
      `INSERT INTO agboss_execution_leases
         (tenant_id, root_execution_id, holder_instance_id, lease_epoch, expires_at, released)
       VALUES ('default', 'run-1', 'pod-old', 1, clock_timestamp() + interval '1 hour', false)`,
    );

    const error = await migratePostgres({ url }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "postgres.live-leases", count: 1, holders: ["pod-old"] });
  });

  it("AC5: a database with no history (the first migrate) has no leases to look at", async () => {
    const report = await migratePostgres({ url: await freshSchema() });

    expect(report.applied.length).toBeGreaterThan(30);
  });
});
