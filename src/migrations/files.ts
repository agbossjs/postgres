import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** One migration this package ships: `migrations/NNNN_<name>.sql`. */
export interface MigrationFile {
  /** `NNNN`: the order, from 1 with no gaps. */
  readonly version: number;
  /** `<name>`: what it creates. */
  readonly name: string;
  /** Its statements. */
  readonly sql: string;
  /** The SHA-256 of its statements (line ends normalized): an applied file may not change. */
  readonly checksum: string;
}

/** The package's `migrations/` folder: next to `dist/` and `src/`, so both find it. */
export const PACKAGE_MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** The SHA-256 of a migration's text, its line ends as LF (a Windows checkout changes nothing). */
export const checksumOf = (sql: string): string =>
  createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");

/** One file of the folder as a migration; `undefined` for a file that is not one. */
function migrationOf(folder: string, file: string): MigrationFile | undefined {
  const match = FILE_NAME.exec(file);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const sql = readFileSync(join(folder, file), "utf8");
  return { version: Number(match[1]), name: match[2], sql, checksum: checksumOf(sql) };
}

/**
 * The migrations of `folder`, in order. Versions run from 1 with no gap and no repeat — a folder
 * that breaks this fails here, before anything is applied.
 */
export function migrationsIn(folder: string = PACKAGE_MIGRATIONS): readonly MigrationFile[] {
  const found = readdirSync(folder)
    .map((file) => migrationOf(folder, file))
    .filter((migration) => migration !== undefined)
    .sort((left, right) => left.version - right.version);
  found.forEach((migration, index) => {
    if (migration.version !== index + 1)
      throw new Error(
        `migration ${migration.name} has version ${String(migration.version)}, expected ${String(index + 1)}: versions run from 1 with no gap or repeat (${folder})`,
      );
  });
  return found;
}

/** The newest version of `migrations` (0 when there are none). */
export const newestVersionOf = (migrations: readonly MigrationFile[]): number =>
  migrations.at(-1)?.version ?? 0;
