import pg from "pg";
import { z } from "zod";
import { connectedInUtc } from "../connection/utc-session.js";
import { quotedIdentifier, sessionOptionsOf } from "../connection/settings.js";

/**
 * The index behind `PostgresCheckpointSaver.latestByStep` (agbossjs/agboss#962): a thread's newest
 * checkpoint by LangGraph's step — `metadata.step`, -2 when missing or not a number — then by the
 * greatest `checkpoint_id` by code point (`COLLATE "C"`, agbossjs/agboss#1115), as one walk of an index. Correctness never depends on it:
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

/** The answer of the build's lock: whether this session got it. */
const LockRow = z.object({ got: z.boolean() });

/**
 * How long a drop of an INVALID index waits for a lock (agbossjs/agboss#1116). `DROP INDEX
 * CONCURRENTLY` waits for every transaction that holds a lock on `checkpoints`, even an idle one;
 * the drop is housekeeping, so it gives up and leaves the index for the next run instead of making
 * the run wait for a stranger's transaction.
 */
export const DROP_LOCK_TIMEOUT_MS = 3000;

/**
 * A step that failed: `cause` is why (the build's own error, or the drop's lock timeout), and
 * `invalidIndexLeft` whether an INVALID index stays behind for the next run to drop.
 */
export class StepIndexFailure extends Error {
  constructor(
    override readonly cause: unknown,
    readonly invalidIndexLeft: boolean,
  ) {
    // internal: `migrateWith` turns it into `PostgresStepIndexError`, the background build drops
    // it, so neither a name nor the `cause` option (the parameter property sets it) is read
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

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
    options: sessionOptionsOf(options.schema),
  });
  // a dropped session rejects the statement in flight, which is the run's error
  client.on("error", () => undefined);
  await connectedInUtc(client);
  try {
    const { schema } = options;
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1, hashtext($2)) AS got", [
      INDEX_LOCK_KEY,
      schema,
    ]);
    if (!LockRow.parse(rows[0]).got) return "skipped";
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
  if (state?.valid === false) {
    try {
      await dropWithinBound(client, qualified);
    } catch (cause) {
      // a blocked drop ends the run: the build would find the INVALID index and skip itself
      throw new StepIndexFailure(cause, true);
    }
  }
  try {
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${STEP_INDEX_NAME} ON ${qualified}.checkpoints ${STEP_INDEX_COLUMNS}`,
    );
  } catch (error) {
    throw new StepIndexFailure(error, !(await dropInvalid(client, qualified)));
  }
  return "built";
}

/**
 * `DROP INDEX CONCURRENTLY` (never a plain `DROP INDEX`, which would hold every write to
 * `checkpoints` while it waits for its lock) under a `lock_timeout` of {@link DROP_LOCK_TIMEOUT_MS}.
 * The timeout is the session's for this statement only: the build that may follow waits as long as
 * it needs.
 */
async function dropWithinBound(client: pg.Client, qualified: string): Promise<void> {
  await client.query(`SET lock_timeout = ${String(DROP_LOCK_TIMEOUT_MS)}`);
  try {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${qualified}.${STEP_INDEX_NAME}`);
  } finally {
    await client.query("RESET lock_timeout");
  }
}

/**
 * A cancelled or failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index (agbossjs/agboss#1102):
 * dropped here, never a valid one, so the failed run leaves none. A drop that fails too (the role
 * does not own the table, the session is gone, a transaction holding a lock on `checkpoints` does
 * not end within the bound, #1116) changes nothing and never replaces the build's own error: the
 * next run drops the leftover before it builds. Whether the index is gone is the answer.
 */
export async function dropInvalid(client: pg.Client, qualified: string): Promise<boolean> {
  try {
    const { rows } = await client.query(
      `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = $1 AND c.relnamespace = $2::regnamespace`,
      [STEP_INDEX_NAME, qualified],
    );
    if (rows[0] === undefined) return true;
    if (IndexState.parse(rows[0]).valid !== false) return true;
    await dropWithinBound(client, qualified);
    return true;
  } catch {
    // the build's own error is the run's
    return false;
  }
}

/**
 * The index step of a migration run, after its lock is released: what it did, or `undefined` when
 * it runs in the background (a failed build there is a slower read; the next run builds it).
 */
export async function stepIndexAfter(
  options: { readonly url: string; readonly signal?: AbortSignal | undefined },
  schema: string,
  inBackground: boolean,
): Promise<StepIndexResult | undefined> {
  options.signal?.throwIfAborted();
  const build = buildStepIndex({ url: options.url, schema });
  if (!inBackground) return build;
  build.catch(() => undefined);
  return undefined;
}
