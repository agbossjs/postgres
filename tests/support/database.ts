import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect } from "vitest";
import { migratePostgres } from "../../src/index.js";
import { DROP_BOUND_MS, dropOnServer } from "./drop-schemas.js";

/**
 * The database of one test file: a schema of its own (`t_<random>`) on `AGBOSS_POSTGRES_TEST_URL`,
 * every connection's `search_path` set to it through the URL, dropped after the file.
 */

/** The server's URL (the global setup checked it is set and answers). */
export const serverUrl = (): string => {
  const url = process.env.AGBOSS_POSTGRES_TEST_URL;
  if (url === undefined || url === "") throw new Error("AGBOSS_POSTGRES_TEST_URL is not set");
  return url;
};

/**
 * The server's bounds on a test's session (agbossjs/agboss#978): a statement that waits for a lock
 * a leaked transaction holds, or a session left idle inside a transaction, ends with an error that
 * names it — never a test file hung until its 17-minute timeout (a gate on a loaded machine, with
 * 276 schedules of the lease explorer that take 7 s on an idle one). Far above any wait a test
 * means to make; a bound the database keeps, not a threshold a test asserts.
 */
const SESSION_BOUNDS =
  "-c lock_timeout=60000 -c statement_timeout=120000 -c idle_in_transaction_session_timeout=120000";

/** `url` with every connection's `search_path` set to `schema`, and the session bounds. */
export function urlOnSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema} ${SESSION_BOUNDS}`);
  return parsed.toString();
}

/** The running test file's name: what its connections are called on the server (`application_name`). */
const fileOf = (): string =>
  (expect.getState().testPath ?? "")
    .split("/")
    .pop()
    ?.replace(/\.test\.ts$/u, "") ?? "";

/** A new schema name, unique to this run. */
export const newSchemaName = (): string => `t_${randomBytes(6).toString("hex")}`;

/** Runs `sql` on the server (outside any test schema). */
export async function onServer(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** A schema created now, and the URL of connections to it. */
export async function createSchema(): Promise<{ readonly schema: string; readonly url: string }> {
  const schema = newSchemaName();
  await onServer(`CREATE SCHEMA ${schema}`);
  const url = new URL(urlOnSchema(serverUrl(), schema));
  // #978: the peak of connections says which file held them
  url.searchParams.set("application_name", fileOf().slice(0, 63));
  return { schema, url: url.toString() };
}

/** Drops a test's schema and everything in it, within `DROP_BOUND_MS` (agbossjs/agboss#985); a failure names it. */
export const dropSchema = (schema: string): Promise<void> =>
  dropOnServer(serverUrl())(schema, DROP_BOUND_MS).catch((error: unknown) => {
    throw new Error(`dropping the test schema ${schema}: ${String(error)}`, { cause: error });
  });

/** What a test file's database gives: its URL (after `beforeAll`), its schema. */
export interface TestDatabase {
  readonly url: () => string;
  readonly schema: () => string;
}

/**
 * The file's schema, created and migrated before its tests (`migrated: false` → left empty) and
 * dropped after them.
 */
export function testDatabase(options: { readonly migrated?: boolean } = {}): TestDatabase {
  let created: { readonly schema: string; readonly url: string } | undefined;
  beforeAll(async () => {
    created = await createSchema();
    if (options.migrated ?? true) await migratePostgres({ url: created.url });
  });
  afterAll(async () => {
    if (created !== undefined) await dropSchema(created.schema);
  });
  const current = (): { readonly schema: string; readonly url: string } => {
    if (created === undefined) throw new Error("the test database is created in beforeAll");
    return created;
  };
  return { url: () => current().url, schema: () => current().schema };
}

/** Runs `sql` on the test's schema. */
export async function onSchema(
  url: string,
  sql: string,
  parameters: unknown[] = [],
): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(sql, parameters);
  } finally {
    await client.end();
  }
}

/**
 * Every table of the migrations and LangGraph's checkpoints, emptied: a contract case's `reset`.
 * By `DELETE`, a table that references another first (agbossjs/agboss#760): the explorer resets
 * before every schedule it replays, and a `TRUNCATE` per table — new files for each, 330 ms a reset
 * on a loaded machine — took most of a 15-minute search; the tables hold a few rows, a `DELETE` of
 * all of them is 9 ms. Sequences are kept, as `TRUNCATE` without `RESTART IDENTITY` kept them; the
 * ledger's pruning mark is seeded again, as the migration seeds it.
 */
export const truncateAll = (url: string): Promise<pg.QueryResult> =>
  onSchema(
    url,
    `DO $$ DECLARE t text; BEGIN
       FOR t IN
         WITH RECURSIVE tables AS (
           SELECT c.oid FROM pg_class c
           WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p')
             AND c.relname NOT IN ('agboss_schema_migrations', 'checkpoint_migrations')
         ), refs AS (
           SELECT conrelid AS child, confrelid AS parent FROM pg_constraint
           WHERE contype = 'f' AND connamespace = current_schema()::regnamespace
             AND conrelid <> confrelid
         ), heights(rel, height) AS (
           SELECT oid, 0 FROM tables
           UNION ALL SELECT refs.parent, heights.height + 1 FROM refs JOIN heights ON heights.rel = refs.child
             WHERE heights.height < 64
         )
         SELECT rel::regclass::text FROM heights JOIN tables ON tables.oid = heights.rel
         GROUP BY rel ORDER BY max(height), rel::regclass::text
       LOOP
         EXECUTE format('DELETE FROM %s', t);
       END LOOP;
       -- the ledger's pruning mark is one row the migration seeds (agbossjs/agboss#771)
       IF to_regclass('agboss_cost_entries_pruned') IS NOT NULL THEN
         INSERT INTO agboss_cost_entries_pruned VALUES (true, '-infinity');
       END IF; END $$`,
  );

const created: string[] = [];

afterAll(async () => {
  for (const schema of created.splice(0)) await dropSchema(schema);
});

/** A new empty schema of this test (dropped after the file): its URL. */
export async function freshSchema(): Promise<string> {
  const { schema, url } = await createSchema();
  created.push(schema);
  return url;
}
