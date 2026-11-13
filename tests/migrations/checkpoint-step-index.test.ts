import { SchemaSetup } from "@agboss/core/stores";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import pg from "pg";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { migratePostgres, PostgresCheckpointSaver, PostgresConnection } from "../../src/index.js";
import { INDEX_LOCK_KEY, STEP_INDEX_NAME } from "../../src/migrations/checkpoint-step-index.js";
import { createSchema, dropSchema, onSchema } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#962: the checkpoint index is built `CONCURRENTLY` after the migrations, outside
 * the migration lock, behind a lock of its own that never waits: concurrent starts do not deadlock,
 * one builds, the others go on; writes to a populated table are not held; an INVALID leftover is
 * built again; a re-run does nothing.
 */
const IndexRow = z.object({ valid: z.boolean(), oid: z.string() });
const schemas: string[] = [];
afterEach(async () => {
  for (const schema of schemas.splice(0)) await dropSchema(schema);
});

async function fresh(): Promise<{ readonly schema: string; readonly url: string }> {
  const made = await createSchema();
  schemas.push(made.schema);
  return made;
}

/** The index's `indisvalid` (undefined: there is none) and its oid. */
async function stateOf(url: string): Promise<{ valid?: boolean; oid?: string }> {
  const { rows } = await onSchema(
    url,
    `SELECT i.indisvalid AS valid, c.oid::text AS oid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
    [STEP_INDEX_NAME],
  );
  const row = rows[0] === undefined ? undefined : IndexRow.parse(rows[0]);
  return row === undefined ? {} : { valid: row.valid, oid: row.oid };
}

async function until(done: () => Promise<boolean>, seconds = 60): Promise<void> {
  for (let waited = 0; waited < seconds * 10; waited += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("not within the time");
}

/** `count` checkpoints of one thread, filled in one INSERT. */
const populate = (url: string, count: number) =>
  onSchema(
    url,
    `INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
     SELECT 'old', '', 'id-' || lpad(n::text, 8, '0'), '{}'::jsonb,
            jsonb_build_object('source', 'loop', 'step', n, 'parents', '{}'::jsonb)
       FROM generate_series(0, $1::int - 1) AS n`,
    [count],
  );

describe("agbossjs/agboss#962: the checkpoint index step", () => {
  it("AC1: three concurrent migrations — no deadlock, every one applies or finds, one builds", async () => {
    const { url } = await fresh();

    const reports = await Promise.all([1, 2, 3].map(() => migratePostgres({ url })));

    expect(reports.map((report) => report.applied.length).sort()).toEqual([0, 0, 31]);
    expect(await stateOf(url)).toMatchObject({ valid: true });
  });

  it("AC1: three concurrent starts that migrate are not held by the build; the index follows", async () => {
    const { url } = await fresh();
    const connections = [1, 2, 3].map(
      () => new PostgresConnection({ url, schemaSetup: SchemaSetup.MigrateOnStart }),
    );
    const [first] = connections;
    try {
      await Promise.all(connections.map((connection) => connection.onInit()));
      await until(async () => (await stateOf(url)).valid === true);
      if (first === undefined) throw new Error("no connection");
      const saver = new PostgresCheckpointSaver(first);
      expect(await saver.latestByStep({ configurable: { thread_id: "none" } })).toBeUndefined();
    } finally {
      for (const connection of connections) await connection.onDestroy();
    }
  });

  it("AC1: a run that does not get the build's lock skips it and goes on; the next one builds", async () => {
    const { url } = await fresh();
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    const schema = schemas[0] ?? "";
    await holder.query("SELECT pg_advisory_lock($1, hashtext($2))", [INDEX_LOCK_KEY, schema]);
    try {
      await migratePostgres({ url, schema });
      expect(await stateOf(url)).toEqual({});
    } finally {
      await holder.end();
    }

    await migratePostgres({ url, schema });

    expect(await stateOf(url)).toMatchObject({ valid: true });
  });

  it("AC1: an INVALID leftover is dropped and built again; a re-run changes nothing", async () => {
    const { url, schema } = await fresh();
    await migratePostgres({ url });
    const first = await stateOf(url);
    await migratePostgres({ url });
    expect(await stateOf(url)).toEqual(first);

    await onSchema(url, `UPDATE pg_index SET indisvalid = false WHERE indexrelid = $1::regclass`, [
      `${schema}.${STEP_INDEX_NAME}`,
    ]);
    expect(await stateOf(url)).toMatchObject({ valid: false });
    await migratePostgres({ url });

    const rebuilt = await stateOf(url);
    expect(rebuilt.valid).toBe(true);
    expect(rebuilt.oid).not.toBe(first.oid);
  });

  it("AC1: a populated table keeps taking checkpoint writes while the index builds", async () => {
    const { url } = await fresh();
    await migratePostgres({ url });
    await onSchema(url, `DROP INDEX ${STEP_INDEX_NAME}`);
    await populate(url, 1_000_000);
    const saver = new PostgresCheckpointSaver(connectionTo(url));
    const run = { building: true };
    const latencies: number[] = [];
    const writer = (async () => {
      for (let step = 0; run.building; step += 1) {
        const started = performance.now();
        await saver.put(
          { configurable: { thread_id: "live", checkpoint_ns: "" } },
          { ...emptyCheckpoint(), id: `live-${String(step).padStart(6, "0")}` },
          { source: "loop", step, parents: {} },
          {},
        );
        latencies.push(performance.now() - started);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();

    const buildStarted = performance.now();
    await migratePostgres({ url });
    const built = performance.now() - buildStarted;
    run.building = false;
    await writer;

    const slowest = Math.max(...latencies);
    expect(await stateOf(url)).toMatchObject({ valid: true });
    expect(latencies.length).toBeGreaterThan(5);
    // a plain CREATE INDEX holds every write for the whole build; here none waits for a fraction of it
    expect(slowest).toBeLessThan(Math.max(500, built / 4));
  }, 180_000);
});
