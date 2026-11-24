import { Injectable } from "@agboss/core";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { latestByStepSql } from "../migrations/checkpoint-step-index.js";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { once } from "../connection/once.js";
import { changesOf, rowsOf } from "../connection/query.js";
import { inPoolTransaction } from "../connection/transaction.js";
import { z } from "zod";

/** The configurable key naming a thread's tree: the root execution id, written with every row. */
const ROOT_EXECUTION_ID_KEY = "root_execution_id";

const ThreadRow = z.object({ thread_id: z.string() });

/**
 * LangGraph's `BaseCheckpointSaver` on PostgreSQL (#265 AC7, #482): LangGraph's own `PostgresSaver`
 * on the instance's pool — one pool for every store — in the schema of the connection's
 * `search_path`, plus `ping()` for readiness. Its tables are created by the migrations
 * (`agboss-postgres migrate` calls `PostgresSaver.setup()`), never at start; they follow
 * LangGraph's own updates. Listed in `@Application({ providers })` with
 * `PostgresPausedExecutionRepository`, a pause survives a restart and is resumed on any instance;
 * recovery continues a `running` tree from its last checkpoint. It never ends the shared pool:
 * `PostgresConnection` does, when the instance stops.
 */
@Injectable({ deps: [PostgresConnection] })
export class PostgresCheckpointSaver extends BaseCheckpointSaver {
  readonly #saver: () => Promise<PostgresSaver>;

  constructor(private readonly connection: PostgresConnection) {
    super();
    // built on first use: the schema is read from the database, and the constructor does no I/O
    this.#saver = once(
      async () =>
        new PostgresSaver(connection.pool, this.serde, { schema: await connection.schema() }),
    );
  }

  /** One `SELECT 1` (#300): what `app.checkReadiness()` asks of the checkpoint saver. */
  ping(): Promise<void> {
    return this.connection.ping();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return (await this.#saver()).getTuple(config);
  }

  /**
   * The checkpoint of the thread and namespace newest by `(step, id)` (agbossjs/agboss#962, the
   * core's optional `latestByStep`): one walk of `checkpoints_latest_by_step` for its id, then the
   * saver's own read of it. The step is in the row `put` writes in one statement, so the answer is
   * never stale or half-written.
   */
  async latestByStep(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId: unknown = config.configurable?.thread_id;
    const namespace: unknown = config.configurable?.checkpoint_ns ?? "";
    if (typeof threadId !== "string" || typeof namespace !== "string") return undefined;
    const schema = await this.connection.schema();
    const { rows } = await this.connection.pool.query<{ checkpoint_id: string }>(
      latestByStepSql(schema),
      [threadId, namespace],
    );
    const id = rows[0]?.checkpoint_id;
    if (id === undefined) return undefined;
    return (await this.#saver()).getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: id },
    });
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    yield* (await this.#saver()).list(config, options);
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    // the versions LangGraph passes, as they are: the core's contract passes them too (#511)
    const written = await (await this.#saver()).put(config, checkpoint, metadata, newVersions);
    await this.#rooted(config, "checkpoints", written.configurable?.checkpoint_id);
    return written;
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    await (await this.#saver()).putWrites(config, writes, taskId, taskPath);
    await this.#rooted(config, "checkpoint_writes", config.configurable?.checkpoint_id);
  }

  /**
   * Deletes a tree's checkpoints (agbossjs/agboss#1321d): the thread `rootExecutionId` and every
   * thread whose stored `root_id` is it — never a range or a prefix of thread ids, so no id can
   * reach another tree's rows (`<id>x`, `<id>0/child/…` stay). The checkpoints, their pending
   * writes and the blobs of their threads, in one transaction.
   */
  async deleteThread(rootExecutionId: string): Promise<void> {
    await inPoolTransaction(this.connection.pool, async (client) => {
      const threads = await rowsOf(
        client,
        `SELECT DISTINCT thread_id FROM (
           SELECT thread_id FROM checkpoints WHERE root_id = $1 OR thread_id = $1
           UNION SELECT thread_id FROM checkpoint_writes WHERE root_id = $1 OR thread_id = $1
         ) found`,
        [rootExecutionId],
      );
      const ids = threads.map((row) => ThreadRow.parse(row).thread_id);
      await changesOf(client, "DELETE FROM checkpoint_blobs WHERE thread_id = ANY($1::text[])", [
        ids,
      ]);
      await changesOf(
        client,
        "DELETE FROM checkpoint_writes WHERE root_id = $1 OR thread_id = $1",
        [rootExecutionId],
      );
      await changesOf(client, "DELETE FROM checkpoints WHERE root_id = $1 OR thread_id = $1", [
        rootExecutionId,
      ]);
    });
  }

  /** Stores the tree's root execution id on the row just written (its config names it). */
  async #rooted(config: RunnableConfig, table: string, checkpointId: unknown): Promise<void> {
    const configurable: Readonly<Record<string, unknown>> | undefined = config.configurable;
    const root: unknown = configurable?.[ROOT_EXECUTION_ID_KEY];
    const threadId: unknown = configurable?.thread_id;
    if (typeof root !== "string" || root === "" || typeof threadId !== "string") return;
    if (typeof checkpointId !== "string") return;
    await changesOf(
      this.connection.pool,
      `UPDATE ${table} SET root_id = $1 WHERE thread_id = $2 AND checkpoint_ns = $3
       AND checkpoint_id = $4`,
      [root, threadId, configurable?.checkpoint_ns ?? "", checkpointId],
    );
  }

  /**
   * LangGraph's `PostgresSaver` versions: one past the integer part plus a random fraction, so two
   * branches from one checkpoint never share a blob — the saver's own rule, which its blobs rely on.
   */
  override getNextVersion(current: number | undefined): number {
    return Math.floor(super.getNextVersion(current)) + Math.random();
  }
}
