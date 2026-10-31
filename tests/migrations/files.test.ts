import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checksumOf, migrationsIn, newestVersionOf } from "../../src/migrations/files.js";
import { emptyFolder, migrationsFolder } from "../support/migration-folders.js";
import { pendingMigrations } from "../../src/migrations/history.js";

describe("the package's migration files", () => {
  it("are read in order from migrations/NNNN_<name>.sql, other files ignored", () => {
    const folder = migrationsFolder({ "README.md": "not a migration", "notes.sql": "SELECT 1;" });

    const files = migrationsIn(folder);

    expect(files.map((file) => `${String(file.version)}:${file.name}`)).toEqual([
      "1:execution_leases",
      "2:execution_records",
      "3:execution_trees",
      "4:paused_executions",
      "5:child_execution_queue",
      "6:fenced_effects",
      "7:execution_lease_events",
      "8:execution_lease_yield",
      "9:cost_ledger",
      "10:execution_history",
      "11:rate_limits",
      "12:mesh_requests",
      "13:nul_escape",
      "14:execution_lease_superseded",
      "15:fenced_effect_business_keys",
      "16:outbound_calls",
    ]);
    expect(newestVersionOf(files)).toBe(16);
    expect(files.every((file) => file.checksum === checksumOf(file.sql))).toBe(true);
  });

  it("a gap in the versions fails before anything is applied", () => {
    const folder = migrationsFolder({ "0003_execution_trees.sql": null });

    expect(() => migrationsIn(folder)).toThrow(
      /migration paused_executions has version 4, expected 3/,
    );
  });

  it("a repeated version fails too", () => {
    const folder = migrationsFolder({ "0002_again.sql": "SELECT 1;" });

    expect(() => migrationsIn(folder)).toThrow(/expected 3/);
  });

  it("an empty folder has no migrations: newest version 0", () => {
    const folder = emptyFolder();
    writeFileSync(join(folder, "keep.txt"), "");

    expect(migrationsIn(folder)).toEqual([]);
    expect(newestVersionOf([])).toBe(0);
  });

  it("a checksum does not depend on line ends: a Windows checkout is the same file", () => {
    expect(checksumOf("CREATE TABLE a (id integer);\r\nSELECT 1;\r\n")).toBe(
      checksumOf("CREATE TABLE a (id integer);\nSELECT 1;\n"),
    );
    expect(checksumOf("SELECT 1;")).not.toBe(checksumOf("SELECT 2;"));
  });

  it("pending: the files after the newest applied one", () => {
    const files = migrationsIn();
    const applied = files
      .slice(0, 4)
      .map(({ version, name, checksum }) => ({ version, name, checksum }));

    expect(pendingMigrations(files, applied).map((file) => file.version)).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(pendingMigrations(files, [])).toHaveLength(16);
  });
});
