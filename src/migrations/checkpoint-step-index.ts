import type pg from "pg";
import { quotedIdentifier } from "../connection/settings.js";

/**
 * The index behind `PostgresCheckpointSaver.latestByStep` (agbossjs/agboss#962): a thread's newest
 * checkpoint by LangGraph's step — `metadata.step`, -2 when missing or not a number — then by the
 * greatest `checkpoint_id` by code unit, as one walk of an index.
 *
 * LangGraph's `PostgresSaver.setup()` makes the `checkpoints` table, after this package's numbered
 * migrations have run: so the index is made by the runner right after it, each run, and a run that
 * finds it does nothing. It is made `CONCURRENTLY` — a populated table keeps taking writes while it
 * builds — which PostgreSQL refuses inside a transaction, so it is no numbered migration file (each
 * runs in one). `CONCURRENTLY` can leave an INVALID index behind when it fails or is cancelled:
 * the next run drops that one and makes it again. The expression is IMMUTABLE (`jsonb_typeof`, `->`,
 * `->>`, a text cast to `numeric`); `numeric` rather than `bigint`, so a step that is not an
 * integer cannot make an INSERT fail inside the index.
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

/**
 * Makes the index in `schema`, outside any transaction (`client` is in autocommit); an INVALID one
 * left by a failed earlier build is dropped first. Called once LangGraph's setup made the table.
 */
export async function ensureStepIndex(client: pg.PoolClient, schema: string): Promise<void> {
  const table = `${quotedIdentifier(schema)}.checkpoints`;
  const found = await client.query<{ valid: boolean | null }>(
    `SELECT i.indisvalid AS valid FROM pg_class c
       LEFT JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND c.relnamespace = $2::regnamespace`,
    [STEP_INDEX_NAME, quotedIdentifier(schema)],
  );
  if (found.rows[0]?.valid === false)
    await client.query(
      `DROP INDEX CONCURRENTLY IF EXISTS ${quotedIdentifier(schema)}.${STEP_INDEX_NAME}`,
    );
  await client.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${STEP_INDEX_NAME} ON ${table} ${STEP_INDEX_COLUMNS}`,
  );
}
