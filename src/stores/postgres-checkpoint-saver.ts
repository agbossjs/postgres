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
import { PostgresConnection } from "../connection/postgres-connection.js";
import { once } from "../connection/once.js";

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
/**
 * The current version of every channel the checkpoint holds a value of. `PostgresSaver` writes the
 * blobs of `newVersions` only; the core's checkpoint contract (as its SQLite saver, which keeps the
 * whole checkpoint) expects every value of a `put` back — so each value is written under its
 * current version too: one already stored is left as it is (`ON CONFLICT DO NOTHING`).
 */
function storedVersionsOf(checkpoint: Checkpoint): ChannelVersions {
  return Object.fromEntries(
    Object.entries(checkpoint.channel_versions).filter(
      ([channel]) => channel in checkpoint.channel_values,
    ),
  );
}

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
    return (await this.#saver()).put(config, checkpoint, metadata, {
      ...storedVersionsOf(checkpoint),
      ...newVersions,
    });
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    await (await this.#saver()).putWrites(config, writes, taskId, taskPath);
  }

  async deleteThread(threadId: string): Promise<void> {
    await (await this.#saver()).deleteThread(threadId);
  }

  /**
   * LangGraph's `PostgresSaver` versions: one past the integer part plus a random fraction, so two
   * branches from one checkpoint never share a blob — the saver's own rule, which its blobs rely on.
   */
  override getNextVersion(current: number | undefined): number {
    return Math.floor(super.getNextVersion(current)) + Math.random();
  }
}
