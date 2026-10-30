import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { PACKAGE_MIGRATIONS } from "../../src/migrations/files.js";

/** Folders of migrations a test writes (a copy of the package's, changed), removed after the file. */
const folders: string[] = [];

afterAll(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A new empty folder of this test file. */
export function emptyFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "agboss-postgres-migrations-"));
  folders.push(folder);
  return folder;
}

/** A copy of the package's migrations, with `files` written over it (`null` removes one). */
export function migrationsFolder(files: Readonly<Record<string, string | null>> = {}): string {
  const folder = emptyFolder();
  cpSync(PACKAGE_MIGRATIONS, folder, { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    if (sql === null) rmSync(join(folder, name));
    else writeFileSync(join(folder, name), sql);
  }
  return folder;
}
