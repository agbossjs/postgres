import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";
import { PostgresCheckpointSaver } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/** LangGraph's PostgresSaver behind the core's contract: its versions, its values, its pool. */
const database = testDatabase();

const thread = (threadId: string) => ({ configurable: { thread_id: threadId, checkpoint_ns: "" } });

describe("PostgresCheckpointSaver", () => {
  it("versions as PostgresSaver makes them: one past the integer part, plus a fraction", () => {
    const saver = new PostgresCheckpointSaver(connectionTo(database.url()));

    const first = saver.getNextVersion(undefined);
    const next = saver.getNextVersion(3.25);

    expect(Math.floor(first)).toBe(1);
    expect(Math.floor(next)).toBe(4);
    expect(next).not.toBe(4);
  });

  it("a put with LangGraph's new versions keeps every value, the unchanged ones under their versions", async () => {
    const saver = new PostgresCheckpointSaver(connectionTo(database.url()));
    const first = await saver.put(
      thread("versions-1"),
      {
        ...emptyCheckpoint(),
        id: "c-1",
        channel_values: { a: "one", b: "two" },
        channel_versions: { a: 1, b: 1 },
      },
      { source: "input", step: 1, parents: {} },
      { a: 1, b: 1 },
    );
    await saver.put(
      first,
      {
        ...emptyCheckpoint(),
        id: "c-2",
        channel_values: { a: "one", b: "three" },
        channel_versions: { a: 1, b: 2 },
      },
      { source: "loop", step: 2, parents: {} },
      { b: 2 },
    );

    const latest = await saver.getTuple(thread("versions-1"));
    const earlier = await saver.getTuple({
      configurable: { ...thread("versions-1").configurable, checkpoint_id: "c-1" },
    });

    expect(latest?.checkpoint.channel_values).toEqual({ a: "one", b: "three" });
    expect(earlier?.checkpoint.channel_values).toEqual({ a: "one", b: "two" });
  });

  it("uses the instance's pool and never ends it", async () => {
    const connection = connectionTo(database.url());
    const saver = new PostgresCheckpointSaver(connection);

    await saver.ping();
    await saver.deleteThread("no-such-thread");

    expect(connection.pool.ended).toBe(false);
    expect(await saver.getTuple(thread("no-such-thread"))).toBeUndefined();
  });
});
