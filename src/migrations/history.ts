import type { ClientBase } from "pg";
import { z } from "zod";
import { PostgresMigrationChangedError, PostgresSchemaTooNewError } from "../errors.js";
import { newestVersionOf, type MigrationFile } from "./files.js";

/**
 * The schema history, `agboss_schema_migrations (version, name, checksum, applied_at)`: one row per
 * migration applied, in the schema the connection's `search_path` names first.
 */

export const HISTORY_TABLE = `CREATE TABLE IF NOT EXISTS agboss_schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** PostgreSQL's `undefined_table`: the history does not exist yet. */
const UNDEFINED_TABLE = "42P01";

const AppliedRow = z.object({ version: z.number(), name: z.string(), checksum: z.string() });

/** A migration as the history keeps it. */
export type AppliedMigration = z.infer<typeof AppliedRow>;

const NewestRow = z.object({ newest: z.number().nullable() });

/** Whether the database refused a statement because its table does not exist (yet). */
export const isUndefinedTable = (error: unknown): boolean =>
  error instanceof Error && Reflect.get(error, "code") === UNDEFINED_TABLE;

/** The newest version applied: 0 with no history table or an empty one. */
export async function appliedVersionOf(client: ClientBase): Promise<number> {
  try {
    const { rows } = await client.query(
      "SELECT max(version) AS newest FROM agboss_schema_migrations",
    );
    return NewestRow.parse(rows[0]).newest ?? 0;
  } catch (error) {
    if (isUndefinedTable(error)) return 0;
    throw error;
  }
}

/** Every migration applied, oldest first (the history table must exist). */
export async function appliedMigrationsOf(
  client: ClientBase,
): Promise<readonly AppliedMigration[]> {
  const { rows } = await client.query(
    "SELECT version, name, checksum FROM agboss_schema_migrations ORDER BY version",
  );
  return rows.map((row) => AppliedRow.parse(row));
}

/**
 * The package's migrations not applied yet. Every applied one must be the package's file of its
 * version, unchanged (`PostgresMigrationChangedError`); one the package does not have means a newer
 * package migrated the database (`PostgresSchemaTooNewError`).
 */
export function pendingMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): readonly MigrationFile[] {
  const expected = newestVersionOf(files);
  const newest = applied.at(-1)?.version ?? 0;
  if (newest > expected) throw new PostgresSchemaTooNewError({ applied: newest, expected });
  for (const done of applied) {
    const file = files[done.version - 1];
    if (file?.name !== done.name || file.checksum !== done.checksum)
      throw new PostgresMigrationChangedError({ version: done.version, name: done.name });
  }
  return files.filter((file) => file.version > newest);
}
