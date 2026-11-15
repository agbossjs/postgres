import pg from "pg";
import type { CommandIo } from "../../src/cli.js";
import { STEP_INDEX_NAME } from "../../src/migrations/checkpoint-step-index.js";
import { onSchema, serverUrl } from "./database.js";

/** Helpers of the tests of the checkpoint index step's failures (agbossjs/agboss#1102, #1116). */

export const ioOf = (): CommandIo & { readonly out_: string[]; readonly err_: string[] } => {
  const out_: string[] = [];
  const err_: string[] = [];
  return { env: {}, out_, err_, out: (line) => out_.push(line), err: (line) => err_.push(line) };
};

/** The index's `indisvalid`; undefined when there is no index. */
export async function validityOf(url: string): Promise<boolean | undefined> {
  const { rows } = await onSchema(
    url,
    `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
    [STEP_INDEX_NAME],
  );
  return rows[0] === undefined ? undefined : (rows[0] as { valid: boolean }).valid;
}

export async function until(done: () => Promise<boolean>): Promise<void> {
  for (let waited = 0; waited < 600; waited += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("not within the time");
}

const holders: pg.Client[] = [];

/** Ends every session a test held open. */
export async function closeHolders(): Promise<void> {
  for (const holder of holders.splice(0)) await holder.end().catch(() => undefined);
}

async function holder(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  client.on("error", () => undefined);
  holders.push(client);
  await client.connect();
  return client;
}

/** Holds an old snapshot open (a `CREATE INDEX CONCURRENTLY` waits for it) until the client ends. */
export async function holdSnapshot(url: string): Promise<void> {
  const client = await holder(url);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  await client.query("SELECT count(*) FROM pg_class");
}

/**
 * A session that read one row of `checkpoints` and stays open in its transaction: it holds a lock
 * on the table, which `DROP INDEX CONCURRENTLY` waits for (agbossjs/agboss#1116).
 */
export async function holdReader(
  url: string,
  isolation: "READ COMMITTED" | "REPEATABLE READ",
): Promise<pg.Client> {
  const client = await holder(url);
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query("SELECT 1 FROM checkpoints LIMIT 1");
  return client;
}

/** Cancels the statement of the build once it waits. */
export async function cancelBuild(schema: string): Promise<void> {
  const canceller = new pg.Client({ connectionString: serverUrl() });
  await canceller.connect();
  try {
    await until(async () => {
      const { rows } = await canceller.query(
        `SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity
          WHERE query LIKE 'CREATE INDEX CONCURRENTLY%' AND query LIKE $1 AND pid <> pg_backend_pid()`,
        [`%${schema}%`],
      );
      return rows.length > 0;
    });
  } finally {
    await canceller.end();
  }
}

/**
 * Waits until a statement dropping the index waits for a lock, then writes one checkpoint (a
 * session with a `lock_timeout` of a second) and answers the statement that waited and how long the
 * write took. A plain `DROP INDEX` queues an ACCESS EXCLUSIVE lock request on `checkpoints`, and
 * every write behind it waits; `DROP INDEX CONCURRENTLY` blocks none.
 */
export async function writeWhileDropWaits(
  url: string,
  schema: string,
): Promise<{ readonly dropQuery: string; readonly writeMs: number }> {
  const watcher = new pg.Client({ connectionString: serverUrl() });
  const writer = new pg.Client({ connectionString: url });
  await watcher.connect();
  await writer.connect();
  try {
    let dropQuery = "";
    await until(async () => {
      const { rows } = await watcher.query<{ query: string }>(
        `SELECT query FROM pg_stat_activity
          WHERE query LIKE 'DROP INDEX%' AND query LIKE $1 AND wait_event_type = 'Lock'
            AND pid <> pg_backend_pid()`,
        [`%${schema}%`],
      );
      dropQuery = rows[0]?.query ?? "";
      return rows.length > 0;
    });
    await writer.query("SET lock_timeout = 1000");
    const started = performance.now();
    await writer.query(
      `INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
       VALUES ('live', '', 'w-' || clock_timestamp()::text, '{}'::jsonb, '{"step": 1}'::jsonb)`,
    );
    return { dropQuery, writeMs: performance.now() - started };
  } finally {
    await watcher.end();
    await writer.end();
  }
}
