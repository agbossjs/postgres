import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { migratePostgres } from "../../src/index.js";

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

/** `url` with every connection's `search_path` set to `schema`. */
export function urlOnSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  return parsed.toString();
}

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
  return { schema, url: urlOnSchema(serverUrl(), schema) };
}

/** Drops a test's schema and everything in it. */
export const dropSchema = (schema: string): Promise<void> =>
  onServer(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);

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

/** Every table of the migrations and LangGraph's checkpoints, emptied: a contract case's `reset`. */
export const truncateAll = (url: string): Promise<pg.QueryResult> =>
  onSchema(
    url,
    `DO $$ DECLARE t text; BEGIN
       FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema()
         AND tablename NOT IN ('agboss_schema_migrations', 'checkpoint_migrations') LOOP
         EXECUTE format('TRUNCATE %I CASCADE', t);
       END LOOP; END $$`,
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
