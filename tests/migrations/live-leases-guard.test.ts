import { describe, expect, it } from "vitest";
import { PostgresLiveLeasesError } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { historyOf } from "../support/schema-dump.js";

/**
 * agbossjs/agboss#1104 (ADR-0034): a schema upgrade is stop the old version -> migrate -> deploy. The
 * run that would apply a migration refuses while an execution lease is live on the server's clock
 * (not released, finished or superseded, `expires_at` after the server's now): its holder is an
 * instance of the old version. An idle old instance holds no lease — the guard cannot see it.
 */

/** A later release's migration: the baseline is 0001, so the next one is 0002 (a test's own file). */
const NEXT = { "0002_next_for_1104.sql": "CREATE TABLE agboss_next_for_1104 (id integer);" };

/** The migrations of the package with a later release's next one. */
const withNext = (): ReturnType<typeof migrationsIn> => migrationsIn(migrationsFolder(NEXT));

/** A database at the baseline (a release before the one that adds `NEXT`). */
async function schemaAtBaseline(): Promise<string> {
  const url = await freshSchema();
  await migrateWith({ url }, migrationsIn());
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
    const url = await schemaAtBaseline();
    await leaseOf(url, "run-1", "pod-a");
    await leaseOf(url, "run-2", "pod-b");
    await leaseOf(url, "run-3", "pod-a");

    const error = await migrateWith({ url }, withNext()).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(PostgresLiveLeasesError);
    expect(error).toMatchObject({
      code: "postgres.live-leases",
      count: 3,
      holders: ["pod-a", "pod-b"],
    });
    expect((error as Error).message).toMatch(/3 live execution lease/);
    expect((error as Error).message).toMatch(/allowLiveLeases/);
    expect((await historyOf(url)).at(-1)).toBe("1:baseline_0_1_1");
  });

  it("AC1: the samples are at most 5 holders, the count is all of them", async () => {
    const url = await schemaAtBaseline();
    for (let at = 0; at < 8; at += 1) await leaseOf(url, `run-${String(at)}`, `pod-${String(at)}`);

    const error = await migrateWith({ url }, withNext()).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ count: 8 });
    expect(Reflect.get(error as Error, "holders")).toHaveLength(5);
  });

  it("AC2: only a live lease counts: released, finished, superseded and expired ones do not", async () => {
    const url = await schemaAtBaseline();
    await leaseOf(url, "released", "pod-a", { released: true });
    await leaseOf(url, "finished", "pod-a", { finished: true });
    await leaseOf(url, "superseded", "pod-a", { superseded: true });
    await leaseOf(url, "expired", "pod-a", { expires: "clock_timestamp() - interval '1 second'" });

    const report = await migrateWith({ url }, withNext());

    expect(report.applied.map((migration) => migration.version)).toEqual([2]);
  });

  it("AC3: allowLiveLeases: true migrates over a live lease", async () => {
    const url = await schemaAtBaseline();
    await leaseOf(url, "run-1", "pod-a");

    const report = await migrateWith({ url, allowLiveLeases: true }, withNext());

    expect(report.applied.map((migration) => migration.version)).toEqual([2]);
  });

  it("AC4: nothing to apply is a no-op with live leases", async () => {
    const url = await schemaAtBaseline();
    await leaseOf(url, "run-1", "pod-a");

    const report = await migrateWith({ url }, migrationsIn());

    expect(report.applied).toEqual([]);
  });

  it("AC5: a database with no history (the first migrate) has no leases to look at", async () => {
    const report = await migrateWith({ url: await freshSchema() }, migrationsIn());

    expect(report.applied.map((migration) => migration.version)).toEqual([1]);
  });
});
