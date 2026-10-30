import type pg from "pg";

/**
 * The statements of the stores: rows as `unknown` (each store validates them with zod — rows are
 * never trusted) and the count of rows a write changed.
 */

/** A pool (one statement) or a transaction's connection. */
export type Queryable = pg.Pool | pg.ClientBase;

/** A statement's parameters, `$1` first. */
export type Parameters = readonly unknown[];

/** The rows `sql` gives. */
export async function rowsOf(
  database: Queryable,
  sql: string,
  parameters: Parameters = [],
): Promise<readonly unknown[]> {
  const result = await database.query<Readonly<Record<string, unknown>>>(sql, [...parameters]);
  return result.rows;
}

/** The first row `sql` gives; `undefined` when none. */
export async function firstRowOf(
  database: Queryable,
  sql: string,
  parameters: Parameters = [],
): Promise<unknown> {
  const [first] = await rowsOf(database, sql, parameters);
  return first;
}

/** How many rows `sql` inserted, changed or deleted (or returned). */
export async function changesOf(
  database: Queryable,
  sql: string,
  parameters: Parameters = [],
): Promise<number> {
  const result = await database.query(sql, [...parameters]);
  return result.rowCount ?? 0;
}
