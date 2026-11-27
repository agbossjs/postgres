import type { RunnableConfig } from "@langchain/core/runnables";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";
import { PostgresCheckpointSaver } from "../../src/index.js";
import { recordedConnection, type Sent } from "./recorded-pool.js";

/**
 * What the saver does with a tree's root, with no database (agbossjs/agboss#1321d): the statements
 * the pool is sent, on a pool that answers nothing but the schema. A `put` answers the config it was
 * given with the root named in it, and stores the root on the row it wrote.
 */
const SCHEMA = [{ schema: "public" }];
const checkpoint = (id: string) => ({
  ...emptyCheckpoint(),
  id,
  channel_values: { a: 1 },
  channel_versions: { a: 1 },
});
const META = { source: "loop", step: 1, parents: {} } as const;

const config = (fields: Record<string, unknown>): RunnableConfig => ({
  configurable: { thread_id: "t-1", checkpoint_ns: "", ...fields },
});

/** The statements that set a row's root. */
const rootStatements = (sent: readonly Sent[]): readonly Sent[] =>
  sent.filter(({ sql }) => /^\s*UPDATE (checkpoints|checkpoint_writes) SET root_id/u.test(sql));

describe("PostgresCheckpointSaver.put answers the config with the root it was given", () => {
  it("names the root in the answer and stores it on the row, by thread, namespace and checkpoint id", async () => {
    const { connection, sent } = recordedConnection([SCHEMA]);
    const saver = new PostgresCheckpointSaver(connection);

    const answered = await saver.put(
      config({ root_execution_id: "tree-1" }),
      checkpoint("c-1"),
      META,
      { a: 1 },
    );

    expect(answered.configurable).toMatchObject({
      thread_id: "t-1",
      checkpoint_ns: "",
      checkpoint_id: "c-1",
      root_execution_id: "tree-1",
    });
    expect(
      rootStatements(sent).map(({ sql, values }) => [sql.includes("UPDATE checkpoints"), values]),
    ).toEqual([[true, ["tree-1", "t-1", "", "c-1"]]]);
  });

  it("a namespace is kept as it is on the row", async () => {
    const { connection, sent } = recordedConnection([SCHEMA]);
    const saver = new PostgresCheckpointSaver(connection);

    await saver.put(
      config({ root_execution_id: "tree-1", checkpoint_ns: "sub" }),
      checkpoint("c-2"),
      META,
      { a: 1 },
    );

    expect(rootStatements(sent).map(({ values }) => values)).toEqual([
      ["tree-1", "t-1", "sub", "c-2"],
    ]);
  });

  it("a config with no namespace stores the empty one", async () => {
    const { connection, sent } = recordedConnection([SCHEMA]);
    const saver = new PostgresCheckpointSaver(connection);
    const bare: RunnableConfig = {
      configurable: { thread_id: "t-1", root_execution_id: "tree-1" },
    };

    await saver.put(bare, checkpoint("c-3"), META, { a: 1 });

    expect(rootStatements(sent).map(({ values }) => values)).toEqual([
      ["tree-1", "t-1", "", "c-3"],
    ]);
  });

  it.each([
    ["no root at all", {}],
    ["an empty root", { root_execution_id: "" }],
    ["a root that is no text", { root_execution_id: 7 }],
  ])("%s: the answer names none and no root is stored", async (_name, fields) => {
    const { connection, sent } = recordedConnection([SCHEMA]);
    const saver = new PostgresCheckpointSaver(connection);

    const answered = await saver.put(config(fields), checkpoint("c-4"), META, { a: 1 });

    expect(answered.configurable).not.toHaveProperty("root_execution_id");
    expect(rootStatements(sent)).toEqual([]);
  });

  it("pending writes store the root of the config they are written under", async () => {
    const { connection, sent } = recordedConnection([SCHEMA]);
    const saver = new PostgresCheckpointSaver(connection);

    await saver.putWrites(
      config({ root_execution_id: "tree-1", checkpoint_id: "c-5" }),
      [["a", 1]],
      "task-1",
    );

    const [written] = rootStatements(sent);
    expect(written?.sql).toContain("UPDATE checkpoint_writes");
    expect(written?.values).toEqual(["tree-1", "t-1", "", "c-5"]);
  });

  it("pending writes with no checkpoint id or no root store none", async () => {
    const { connection, sent } = recordedConnection([SCHEMA]);
    const saver = new PostgresCheckpointSaver(connection);

    await saver.putWrites(
      config({ root_execution_id: "tree-1", checkpoint_id: "c-6" }),
      [["a", 1]],
      "task-1",
    );
    const before = rootStatements(sent).length;
    await saver.putWrites(config({ checkpoint_id: "c-6" }), [["a", 1]], "task-2");

    expect(rootStatements(sent)).toHaveLength(before);
  });
});

describe("PostgresCheckpointSaver.deleteThread's statements", () => {
  it("finds the threads of the root, then deletes their blobs by thread and the writes and checkpoints by root", async () => {
    const { connection, sent } = recordedConnection([
      [{ thread_id: "tree-1" }, { thread_id: "tree-1/child/a" }],
    ]);
    const saver = new PostgresCheckpointSaver(connection);

    await saver.deleteThread("tree-1");

    const statements = sent.filter(({ sql }) => !/^(BEGIN|COMMIT)$/u.test(sql));
    expect(statements).toHaveLength(4);
    const [found, blobs, writes, checkpoints] = statements;
    expect(found?.sql).toMatch(
      /SELECT DISTINCT thread_id FROM[\s\S]*checkpoint_writes[\s\S]*root_id = \$1/u,
    );
    expect(found?.values).toEqual(["tree-1"]);
    expect(blobs?.sql).toBe("DELETE FROM checkpoint_blobs WHERE thread_id = ANY($1::text[])");
    expect(blobs?.values).toEqual([["tree-1", "tree-1/child/a"]]);
    expect(writes?.sql).toBe("DELETE FROM checkpoint_writes WHERE root_id = $1 OR thread_id = $1");
    expect(writes?.values).toEqual(["tree-1"]);
    expect(checkpoints?.sql).toBe("DELETE FROM checkpoints WHERE root_id = $1 OR thread_id = $1");
    expect(checkpoints?.values).toEqual(["tree-1"]);
  });

  it("a thread row that is no thread id is refused, nothing deleted", async () => {
    const { connection, sent } = recordedConnection([[{ thread_id: 7 }]]);
    const saver = new PostgresCheckpointSaver(connection);

    await expect(saver.deleteThread("tree-1")).rejects.toThrow();

    expect(sent.some(({ sql }) => sql.startsWith("DELETE"))).toBe(false);
  });
});
