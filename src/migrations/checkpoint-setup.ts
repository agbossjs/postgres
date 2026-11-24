import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type pg from "pg";
import { z } from "zod";
import { isUndefinedTable } from "./history.js";

/**
 * The root execution id of each checkpoint and pending write (agbossjs/agboss#1321d): LangGraph's
 * tables get a `root_id` column and an index on it after `PostgresSaver.setup()` — a step of the
 * setup, never a numbered migration, since LangGraph makes the tables — so a tree's checkpoints are
 * deleted by `root_id = $1`, never by a range or a prefix of thread ids. The saver sets it from the
 * config after each write; a row written without it (a crash between the two) is given its thread
 * id's first segment — the root, as a child thread is `<parent>/child/<id>` — by a trigger. Every
 * statement is rerunnable.
 */
const ROOT_ID_SQL = `
ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS root_id text;
ALTER TABLE checkpoint_writes ADD COLUMN IF NOT EXISTS root_id text;
CREATE INDEX IF NOT EXISTS checkpoints_root ON checkpoints (root_id);
CREATE INDEX IF NOT EXISTS checkpoint_writes_root ON checkpoint_writes (root_id);
CREATE OR REPLACE FUNCTION agboss_checkpoint_root() RETURNS trigger AS $body$
BEGIN
  IF NEW.root_id IS NULL THEN NEW.root_id := split_part(NEW.thread_id, '/child/', 1); END IF;
  RETURN NEW;
END $body$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agboss_checkpoints_root ON checkpoints;
CREATE TRIGGER agboss_checkpoints_root BEFORE INSERT ON checkpoints
  FOR EACH ROW EXECUTE FUNCTION agboss_checkpoint_root();
DROP TRIGGER IF EXISTS agboss_checkpoint_writes_root ON checkpoint_writes;
CREATE TRIGGER agboss_checkpoint_writes_root BEFORE INSERT ON checkpoint_writes
  FOR EACH ROW EXECUTE FUNCTION agboss_checkpoint_root();
UPDATE checkpoints SET root_id = split_part(thread_id, '/child/', 1) WHERE root_id IS NULL;
UPDATE checkpoint_writes SET root_id = split_part(thread_id, '/child/', 1) WHERE root_id IS NULL;`;

const VersionRow = z.object({ newest: z.number().nullable() });

/** LangGraph's checkpoint tables in `schema`, set up by its saver; how many of its migrations ran. */
export async function setupCheckpoints(
  pool: pg.Pool,
  client: pg.PoolClient,
  schema: string,
): Promise<number> {
  const before = await checkpointVersionOf(client);
  await new PostgresSaver(pool, undefined, { schema }).setup();
  await client.query(ROOT_ID_SQL);
  return (await checkpointVersionOf(client)) - before;
}

/** The newest of LangGraph's checkpoint migrations applied (-1: none, its table absent). */
async function checkpointVersionOf(client: pg.PoolClient): Promise<number> {
  try {
    const { rows } = await client.query("SELECT max(v) AS newest FROM checkpoint_migrations");
    return VersionRow.parse(rows[0]).newest ?? -1;
  } catch (error) {
    if (isUndefinedTable(error)) return -1;
    throw error;
  }
}
