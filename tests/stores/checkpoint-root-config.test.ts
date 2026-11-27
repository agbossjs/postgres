import { describe, expect, it } from "vitest";
import {
  checkpointIdOf,
  rootedRowOf,
  ROOT_EXECUTION_ID_KEY,
  withRoot,
} from "../../src/stores/checkpoint-root.js";

/**
 * The configs a checkpoint row's root is made from (agbossjs/agboss#1321d), with nothing else:
 * a config with no `configurable` at all is none of them, never a thrown TypeError.
 */
const CONFIG = {
  configurable: {
    thread_id: "t-1",
    checkpoint_ns: "sub",
    checkpoint_id: "c-1",
    [ROOT_EXECUTION_ID_KEY]: "tree-1",
  },
};

describe("checkpointIdOf", () => {
  it("is the id the config names, and none for a config without one or without `configurable`", () => {
    expect(checkpointIdOf(CONFIG)).toBe("c-1");
    expect(checkpointIdOf({ configurable: { thread_id: "t-1" } })).toBeUndefined();
    expect(checkpointIdOf({})).toBeUndefined();
  });
});

describe("withRoot", () => {
  it("adds the given config's root to what was written, keeping the rest", () => {
    const written = { configurable: { thread_id: "t-1", checkpoint_id: "c-2" } };

    expect(withRoot(written, CONFIG)).toEqual({
      configurable: { thread_id: "t-1", checkpoint_id: "c-2", root_execution_id: "tree-1" },
    });
    expect(written.configurable).not.toHaveProperty("root_execution_id");
  });

  it.each([
    ["a config without `configurable`", {}],
    ["no root", { configurable: { thread_id: "t-1" } }],
    ["an empty root", { configurable: { root_execution_id: "" } }],
    ["a root that is no text", { configurable: { root_execution_id: 7 } }],
  ])("%s: what was written, as it is", (_name, given) => {
    const written = { configurable: { thread_id: "t-1" } };

    expect(withRoot(written, given)).toBe(written);
  });

  it("a written config without `configurable` gets one holding the root", () => {
    expect(withRoot({}, CONFIG)).toEqual({ configurable: { root_execution_id: "tree-1" } });
  });
});

describe("rootedRowOf", () => {
  it("names the root, the thread, the namespace and the checkpoint of the row", () => {
    expect(rootedRowOf(CONFIG, "c-9")).toEqual({
      root: "tree-1",
      threadId: "t-1",
      namespace: "sub",
      checkpointId: "c-9",
    });
  });

  it("a config with no namespace has the empty one", () => {
    const bare = { configurable: { thread_id: "t-1", root_execution_id: "tree-1" } };

    expect(rootedRowOf(bare, "c-9")?.namespace).toBe("");
  });

  it.each([
    ["no `configurable`", {}, "c-9"],
    ["no root", { configurable: { thread_id: "t-1" } }, "c-9"],
    ["an empty root", { configurable: { thread_id: "t-1", root_execution_id: "" } }, "c-9"],
    ["a root that is no text", { configurable: { thread_id: "t-1", root_execution_id: 7 } }, "c-9"],
    ["no thread", { configurable: { root_execution_id: "tree-1" } }, "c-9"],
    [
      "a thread that is no text",
      { configurable: { thread_id: 7, root_execution_id: "tree-1" } },
      "c-9",
    ],
    ["no checkpoint id", CONFIG, undefined],
    ["a checkpoint id that is no text", CONFIG, 7],
  ])("%s: no row to root", (_name, config, checkpointId) => {
    expect(rootedRowOf(config, checkpointId)).toBeUndefined();
  });
});
