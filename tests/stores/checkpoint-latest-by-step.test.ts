import { emptyCheckpoint, type CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { describe, expect, it, vi } from "vitest";
import { PostgresCheckpointSaver } from "../../src/index.js";
import { STEP_INDEX_NAME } from "../../src/migrations/checkpoint-step-index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#962: `latestByStep` — the newest checkpoint of a thread's namespace by
 * `(step, id)` — is two statements and no list, on 10 000 checkpoints; the index it walks is made
 * by the migration on a populated table, and its answer is the scan's.
 */
const database = testDatabase();
const at = (thread: string, namespace = "") => ({
  configurable: { thread_id: thread, checkpoint_ns: namespace },
});

/** Puts a checkpoint through the saver (one statement of its own: the step is in the row). */
const put = (
  saver: PostgresCheckpointSaver,
  where: ReturnType<typeof at>,
  id: string,
  step: number | undefined,
  version = (step ?? 0) + 1,
) =>
  saver.put(
    where,
    {
      ...emptyCheckpoint(),
      id,
      channel_values: { marker: `${id}@${String(step)}` },
      channel_versions: { marker: version },
    },
    // a checkpoint with no step: the metadata as an older writer left it
    step === undefined
      ? JSON.parse('{"source":"loop","parents":{}}')
      : ({ source: "loop", step, parents: {} } satisfies CheckpointMetadata),
    { marker: version },
  );

/** `count` checkpoints of `thread`, step = position, in one INSERT. */
const populate = (url: string, thread: string, count: number) =>
  onSchema(
    url,
    `INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
     SELECT $1, '', 'id-' || lpad(n::text, 6, '0'), jsonb_build_object('v', 4, 'id', 'id-' || lpad(n::text, 6, '0')),
            jsonb_build_object('source', 'loop', 'step', n, 'parents', '{}'::jsonb)
       FROM generate_series(0, $2::int - 1) AS n`,
    [thread, count],
  );

/** A step of a random history: now and then missing or fractional. */
function stepAt(next: () => number): number | undefined {
  if (next() < 0.15) return undefined;
  return next() < 0.15 ? 1.5 : Math.floor(next() * 6) - 1;
}

/** What the full scan answers: the newest by `(step, id by code unit)` of a listed namespace. */
async function scanned(saver: PostgresCheckpointSaver, place: ReturnType<typeof at>) {
  const listed = [];
  for await (const tuple of saver.list(place)) listed.push(tuple);
  const stepOf = (metadata: CheckpointMetadata | undefined): number =>
    typeof metadata?.step === "number" ? metadata.step : -2;
  const before = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);
  listed.sort(
    (a, b) => stepOf(b.metadata) - stepOf(a.metadata) || before(a.checkpoint.id, b.checkpoint.id),
  );
  return listed[0]?.checkpoint.id;
}

describe("agbossjs/agboss#962: PostgresCheckpointSaver.latestByStep", () => {
  it("AC1: 10 000 checkpoints — two statements, the first an index walk with no sort and no scan", async () => {
    await populate(database.url(), "busy", 10_000);
    const connection = connectionTo(database.url());
    const saver = new PostgresCheckpointSaver(connection);
    await saver.getTuple(at("busy")); // the saver's own setup, once
    const query = vi.spyOn(connection.pool, "query");

    const latest = await saver.latestByStep(at("busy"));

    expect(latest?.config.configurable?.checkpoint_id).toBe("id-009999");
    const statements = query.mock.calls.map(([text]) => (typeof text === "string" ? text : ""));
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/LIMIT 1/);
    const { rows } = await onSchema(
      database.url(),
      `EXPLAIN SELECT checkpoint_id FROM checkpoints WHERE thread_id = 'busy' AND checkpoint_ns = ''
       ORDER BY (CASE WHEN jsonb_typeof(metadata->'step') = 'number' THEN (metadata->>'step')::numeric ELSE -2 END) DESC,
                checkpoint_id COLLATE "C" DESC LIMIT 1`,
    );
    const plan = rows.map((row: Record<string, string>) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain(STEP_INDEX_NAME);
    expect(plan).not.toMatch(/Sort|Seq Scan/);
  });

  it("AC1: it answers what the full scan answers on random histories — ties by code unit, a missing or fractional step", async () => {
    const saver = new PostgresCheckpointSaver(connectionTo(database.url()));
    const ids = ["a", "b", "B", "Z", "a-1", "A-1", "0f", "zz", "m"];
    const places = [at("random"), at("random", "child")];
    let seed = 962;
    const next = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let round = 0; round < 40; round += 1) {
      const where = places[Math.floor(next() * places.length)] ?? at("random");
      await put(saver, where, ids[Math.floor(next() * ids.length)] ?? "a", stepAt(next));
      for (const place of places)
        expect((await saver.latestByStep(place))?.checkpoint.id).toBe(await scanned(saver, place));
    }
    expect(await saver.latestByStep(at("nobody"))).toBeUndefined();
  });

  it("AC1: a read while another connection writes is a whole stored checkpoint, never going back", async () => {
    const writer = new PostgresCheckpointSaver(connectionTo(database.url()));
    const reader = new PostgresCheckpointSaver(connectionTo(database.url()));
    let written = 0;
    const writes = (async () => {
      for (let step = 0; step < 30; step += 1) {
        await put(writer, at("live"), `id-${String(step).padStart(3, "0")}`, step);
        written = step + 1;
      }
    })();
    let seen = -1;
    while (written < 30) {
      const tuple = await reader.latestByStep(at("live"));
      if (tuple === undefined) continue;
      const step = Number(tuple.checkpoint.id.slice(3));
      expect(tuple.checkpoint.channel_values).toEqual({
        marker: `${tuple.checkpoint.id}@${String(step)}`,
      });
      expect(step).toBeGreaterThanOrEqual(seen);
      seen = step;
    }
    await writes;
    expect((await reader.latestByStep(at("live")))?.checkpoint.id).toBe("id-029");
  });
});
