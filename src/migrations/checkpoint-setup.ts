import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type pg from "pg";
import { z } from "zod";
import { ensureStepIndex } from "./checkpoint-step-index.js";
import { isUndefinedTable } from "./history.js";

const VersionRow = z.object({ newest: z.number().nullable() });

/** LangGraph's checkpoint tables in `schema`, set up by its saver, and our index on them; how many of LangGraph's migrations ran. */
export async function setupCheckpoints(
  pool: pg.Pool,
  client: pg.PoolClient,
  schema: string,
): Promise<number> {
  const before = await checkpointVersionOf(client);
  await new PostgresSaver(pool, undefined, { schema }).setup();
  const ran = (await checkpointVersionOf(client)) - before;
  // agbossjs/agboss#962: once the table is there
  await ensureStepIndex(client, schema);
  return ran;
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
