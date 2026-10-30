import { onSchema } from "./database.js";

/**
 * What the schema is — every table's columns, every index and constraint of the test's schema, as
 * text — so a test sees that a second migration run changed nothing.
 */
export async function schemaDumpOf(url: string): Promise<string> {
  const columns = await onSchema(
    url,
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema = current_schema()
     ORDER BY table_name, ordinal_position`,
  );
  const indexes = await onSchema(
    url,
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname",
  );
  const constraints = await onSchema(
    url,
    `SELECT conname, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
     JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = current_schema()
     ORDER BY conname`,
  );
  return JSON.stringify([columns.rows, indexes.rows, constraints.rows]);
}

/** The schema's history: each migration's version and name. */
export async function historyOf(url: string): Promise<readonly string[]> {
  const { rows } = await onSchema(
    url,
    "SELECT version, name FROM agboss_schema_migrations ORDER BY version",
  );
  return rows.map((row: { version: number; name: string }) => `${String(row.version)}:${row.name}`);
}

/** The tables of the test's schema. */
export async function tablesOf(url: string): Promise<readonly string[]> {
  const { rows } = await onSchema(
    url,
    "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename",
  );
  return rows.map((row: { tablename: string }) => row.tablename);
}
