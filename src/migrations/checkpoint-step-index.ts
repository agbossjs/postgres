import pg from "pg";
import { z } from "zod";
import { quotedIdentifier, searchPathOptionOf } from "../connection/settings.js";

/**
 * The index behind `PostgresCheckpointSaver.latestByStep` (agbossjs/agboss#962): a thread's newest
 * checkpoint by LangGraph's step — `metadata.step`, -2 when missing or not a number — then by the
 * greatest `checkpoint_id` by code unit, as one walk of an index. Correctness never depends on it:
 * `latestByStep` answers the same without it, slower.
 *
 * It is a step of its own after the migrations — `checkpoints` is made by LangGraph's setup, after
 * the numbered files — built `CREATE INDEX CONCURRENTLY`, so a populated table keeps taking writes
 * while it builds. `CONCURRENTLY` waits for every other transaction of the database, and the
 * migration lock's waiters are in one: it therefore runs only after the run released that lock, and
 * is guarded by a session-level `pg_try_advisory_lock` of its own that never waits — a run that does
 * not get it (another is building) skips the step and goes on. A build that crashed leaves an
 * INVALID index; the next run that holds the lock drops it (`DROP INDEX CONCURRENTLY`) and builds
 * again. The expression is IMMUTABLE (`jsonb_typeof`, `->`, `->>`, a text cast to `numeric`);
 * `numeric` rather than `bigint`, so a step that is not an integer cannot make an INSERT fail
 * inside the index.
 */
export const STEP_INDEX_NAME = "checkpoints_latest_by_step";

/** The order key of a checkpoint row; the saver's read orders by this very expression. */
export const STEP_EXPRESSION = `(CASE WHEN jsonb_typeof(metadata->'step') = 'number' THEN (metadata->>'step')::numeric ELSE -2 END)`;

/** The columns of the index: a read of one thread and namespace walks it newest first. */
export const STEP_INDEX_COLUMNS = `(thread_id, checkpoint_ns, ${STEP_EXPRESSION} DESC, checkpoint_id COLLATE "C" DESC)`;

/** The statement of the saver's read in `schema`: the newest checkpoint's id, one index walk. */
export const latestByStepSql = (schema: string): string =>
  `SELECT checkpoint_id FROM ${quotedIdentifier(schema)}.checkpoints
   WHERE thread_id = $1 AND checkpoint_ns = $2
   ORDER BY ${STEP_EXPRESSION} DESC, checkpoint_id COLLATE "C" DESC LIMIT 1`;

/** The key of the advisory lock of the build (with the schema's hash as its second half). */
export const INDEX_LOCK_KEY = 0x41474254;

/** What a run's index step did. */
export type StepIndexResult = "built" | "present" | "skipped";

const IndexState = z.object({ valid: z.boolean().nullable() });

/**
 * Builds the index in `schema` on a session of its own (never inside a transaction), unless
 * another run holds the build's lock (`skipped`); an INVALID one is dropped and built again.
 */
export async function buildStepIndex(options: {
  readonly url: string;
  readonly schema: string;
}): Promise<StepIndexResult> {
  const client = new pg.Client({
    connectionString: options.url,
    options: searchPathOptionOf(options.schema),
  });
  // a dropped session rejects the statement in flight, which is the run's error
  client.on("error", () => undefined);
  await client.connect();
  try {
    const { schema } = options;
    const got = await client.query<{ got: boolean }>(
      "SELECT pg_try_advisory_lock($1, hashtext($2)) AS got",
      [INDEX_LOCK_KEY, schema],
    );
    if (got.rows[0]?.got !== true) return "skipped";
    return await buildLocked(client, schema);
  } finally {
    await client.end();
  }
}

async function buildLocked(client: pg.Client, schema: string): Promise<StepIndexResult> {
  const qualified = quotedIdentifier(schema);
  const found = await client.query(
    `SELECT i.indisvalid AS valid FROM pg_class c
       LEFT JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND c.relnamespace = $2::regnamespace`,
    [STEP_INDEX_NAME, qualified],
  );
  const state = found.rows[0] === undefined ? undefined : IndexState.parse(found.rows[0]);
  if (state?.valid === true) return "present";
  if (state?.valid === false)
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${qualified}.${STEP_INDEX_NAME}`);
  await client.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${STEP_INDEX_NAME} ON ${qualified}.checkpoints ${STEP_INDEX_COLUMNS}`,
  );
  return "built";
}
