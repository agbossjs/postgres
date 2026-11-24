import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checksumOf, migrationsIn, newestVersionOf } from "../../src/migrations/files.js";
import { emptyFolder, migrationsFolder } from "../support/migration-folders.js";
import { pendingMigrations } from "../../src/migrations/history.js";
import { PostgresMigrationChangedError } from "../../src/index.js";

describe("the package's migration files", () => {
  it("are read in order from migrations/NNNN_<name>.sql, other files ignored", () => {
    // each of these names breaks the NNNN_<name>.sql form in one place: read as a migration, any
    // of them would repeat or skip a version and fail the folder
    const folder = migrationsFolder({
      "README.md": "not a migration",
      "notes.sql": "SELECT 1;",
      "x0001_prefixed.sql": "SELECT 1;",
      "0001_suffixed.sql.bak": "SELECT 1;",
      "001_three_digits.sql": "SELECT 1;",
      "00001_five_digits.sql": "SELECT 1;",
      "0002_Upper_case.sql": "SELECT 1;",
      "0002_.sql": "SELECT 1;",
      "0002-dash.sql": "SELECT 1;",
      "0002_dotted.txt": "SELECT 1;",
    });

    const files = migrationsIn(folder);

    expect(files.map((file) => `${String(file.version)}:${file.name}`)).toEqual([
      "1:baseline_0_1_1",
    ]);
    expect(newestVersionOf(files)).toBe(1);
    expect(files.every((file) => file.checksum === checksumOf(file.sql))).toBe(true);
  });

  it("a gap in the versions fails before anything is applied", () => {
    const folder = migrationsFolder({ "0003_skips_two.sql": "SELECT 1;" });

    expect(() => migrationsIn(folder)).toThrow(/migration skips_two has version 3, expected 2/);
  });

  it("a repeated version fails too", () => {
    const folder = migrationsFolder({ "0001_again.sql": "SELECT 1;" });

    expect(() => migrationsIn(folder)).toThrow(/expected 2/);
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
    const files = migrationsIn(
      migrationsFolder({ "0002_second.sql": "SELECT 1;", "0003_third.sql": "SELECT 1;" }),
    );
    const applied = files
      .slice(0, 1)
      .map(({ version, name, checksum }) => ({ version, name, checksum }));

    expect(pendingMigrations(files, applied).map((file) => file.version)).toEqual([2, 3]);
    expect(pendingMigrations(files, [])).toHaveLength(3);
  });

  it("pending: an applied version the package has no file for (0) is a changed history", () => {
    const files = migrationsIn();

    expect(() =>
      pendingMigrations(files, [{ version: 0, name: "before_one", checksum: "x" }]),
    ).toThrow(PostgresMigrationChangedError);
  });
});
