import type { RunnableConfig } from "@langchain/core/runnables";

/**
 * The tree a checkpoint row belongs to (agbossjs/agboss#1321d): the framework names it in the
 * config's `configurable.root_execution_id`, and the saver stores it on the row (`root_id`) so a
 * tree's checkpoints are deleted by it, never by a range or a prefix of thread ids. Pure functions
 * of the configs: what the statements are made of, tested on their own.
 */

/** The configurable key naming a thread's tree: the root execution id, written with every row. */
export const ROOT_EXECUTION_ID_KEY = "root_execution_id";

/** The checkpoint id a config names (`undefined`: none, or a config with no `configurable`). */
export const checkpointIdOf = (config: RunnableConfig): unknown =>
  config.configurable?.checkpoint_id;

/**
 * The config a `put` answers, with the tree's root the given config named: the next `put` is given
 * this config (LangGraph chains them), and a child checkpoint written without its root would be
 * given the thread id's first segment by the table's trigger — another tree's root for a thread
 * whose id merely looks like a child's.
 */
export function withRoot(written: RunnableConfig, given: RunnableConfig): RunnableConfig {
  const root: unknown = given.configurable?.[ROOT_EXECUTION_ID_KEY];
  if (typeof root !== "string" || root === "") return written;
  return { ...written, configurable: { ...written.configurable, [ROOT_EXECUTION_ID_KEY]: root } };
}

/** The key of the row a root is stored on, and the root: from the config the row was written under. */
export interface RootedRow {
  readonly root: string;
  readonly threadId: string;
  readonly namespace: unknown;
  readonly checkpointId: string;
}

/** The root to store on the row `checkpointId` of `config`'s thread; `undefined` when the config names no root, no thread or the row has no id. */
export function rootedRowOf(config: RunnableConfig, checkpointId: unknown): RootedRow | undefined {
  const configurable: unknown = config.configurable;
  if (typeof configurable !== "object" || configurable === null) return undefined;
  const root: unknown = Reflect.get(configurable, ROOT_EXECUTION_ID_KEY);
  const threadId: unknown = Reflect.get(configurable, "thread_id");
  if (typeof root !== "string" || root === "" || typeof threadId !== "string") return undefined;
  if (typeof checkpointId !== "string") return undefined;
  const namespace: unknown = Reflect.get(configurable, "checkpoint_ns") ?? "";
  return { root, threadId, namespace, checkpointId };
}
