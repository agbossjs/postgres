import type { RunnableConfig } from "@langchain/core/runnables";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";
import { PostgresCheckpointSaver } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * A tree's checkpoints are deleted by the root execution id each row stores (agbossjs/agboss#1321d),
 * never by a range or a prefix of thread ids: the thread, every child thread of the tree — also a
 * remote child whose id names no root — and nothing of another tree (`<id>x`, `<id>0/child/…`).
 */
const database = testDatabase();

const at = (threadId: string, root?: string): RunnableConfig => ({
  configurable: {
    thread_id: threadId,
    checkpoint_ns: "",
    ...(root === undefined ? {} : { root_execution_id: root }),
  },
});

async function put(saver: PostgresCheckpointSaver, threadId: string, root?: string) {
  const config = await saver.put(
    at(threadId, root),
    {
      ...emptyCheckpoint(),
      id: `c-${threadId}`,
      channel_values: { a: threadId },
      channel_versions: { a: 1 },
    },
    { source: "loop", step: 1, parents: {} },
    { a: 1 },
  );
  await saver.putWrites(
    { configurable: { ...config.configurable, root_execution_id: root } },
    [["a", threadId]],
    "task-1",
  );
}

/** The threads of a table, sorted here by code unit: the database's collation (`en_US`) orders `/` and digits its own way. */
const threadsOf = async (table: "checkpoints" | "checkpoint_writes"): Promise<string[]> =>
  (await onSchema(database.url(), `SELECT DISTINCT thread_id FROM ${table}`)).rows
    .map((row) => (row as { thread_id: string }).thread_id)
    .sort();

describe("PostgresCheckpointSaver.deleteThread by root (agbossjs/agboss#1321d)", () => {
  it("deletes the root's thread and every thread with that stored root, and no other tree's", async () => {
    const saver = new PostgresCheckpointSaver(connectionTo(database.url()));
    await put(saver, "root", "root");
    await put(saver, "root/child/c1", "root");
    await put(saver, "root/child/c1/child/c2", "root");
    // a remote child: its thread names no root, its stored root does
    await put(saver, "remote-1", "root");
    await put(saver, "rootx", "rootx");
    await put(saver, "root0/child/x", "root0");
    await put(saver, "root/child/x-evil", "x-evil");

    await saver.deleteThread("root");

    for (const table of ["checkpoints", "checkpoint_writes"] as const)
      expect(await threadsOf(table)).toEqual(["root/child/x-evil", "root0/child/x", "rootx"]);
    expect(await saver.getTuple(at("root"))).toBeUndefined();
    expect(await saver.getTuple(at("remote-1"))).toBeUndefined();
    expect((await saver.getTuple(at("rootx")))?.checkpoint.channel_values).toEqual({ a: "rootx" });
  });

  it("a chain of puts keeps the root: the config put answers names it, the next row is of that tree", async () => {
    const saver = new PostgresCheckpointSaver(connectionTo(database.url()));
    const checkpoint = (id: string, step: number) => ({
      ...emptyCheckpoint(),
      id,
      channel_values: { a: step },
      channel_versions: { a: step },
    });
    const first = await saver.put(
      at("chain/child/z", "z-root"),
      checkpoint("c-1", 1),
      { source: "input", step: 1, parents: {} },
      { a: 1 },
    );
    expect(first.configurable?.root_execution_id).toBe("z-root");

    const second = await saver.put(
      first,
      checkpoint("c-2", 2),
      { source: "loop", step: 2, parents: {} },
      { a: 2 },
    );

    expect(second.configurable?.root_execution_id).toBe("z-root");
    const { rows } = await onSchema(
      database.url(),
      "SELECT checkpoint_id, root_id FROM checkpoints WHERE thread_id = 'chain/child/z' ORDER BY 1",
    );
    expect(rows).toEqual([
      { checkpoint_id: "c-1", root_id: "z-root" },
      { checkpoint_id: "c-2", root_id: "z-root" },
    ]);
    // a put whose config names no root answers the config as written
    const plain = await saver.put(
      at("plain-thread"),
      checkpoint("c-3", 1),
      { source: "input", step: 1, parents: {} },
      { a: 1 },
    );
    expect(plain.configurable).not.toHaveProperty("root_execution_id");
  });

  it("a row written without the config's root gets its thread id's first segment", async () => {
    const saver = new PostgresCheckpointSaver(connectionTo(database.url()));
    await put(saver, "plain/child/p1");

    const { rows } = await onSchema(
      database.url(),
      "SELECT root_id FROM checkpoints WHERE thread_id = 'plain/child/p1'",
    );

    expect(rows).toEqual([{ root_id: "plain" }]);
  });

  it("deleting a root nothing has is a no-op", async () => {
    const saver = new PostgresCheckpointSaver(connectionTo(database.url()));

    await expect(saver.deleteThread("never-written")).resolves.toBeUndefined();
  });
});
