import { ExecutionRecordStatus, IdGenerator, type NewTurn, type TurnOutcome } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { afterEach } from "vitest";
import { PostgresConnection, PostgresExecutionRecordRepository } from "../../src/index.js";
import { TestApplicationContext } from "./application-context.js";

/** The connections a test opened, ended after it. */
const opened: PostgresConnection[] = [];

afterEach(async () => {
  for (const connection of opened.splice(0)) await connection.onDestroy();
});

/** A connection of this test to `url` (ended after the test). */
export function connectionTo(url: string, poolSize = 4): PostgresConnection {
  const connection = new PostgresConnection({ url, poolSize });
  opened.push(connection);
  return connection;
}

/**
 * Runs `body`, then ends every connection `connectionTo` made during it, however it ended
 * (agbossjs/agboss#978): a round of a race that builds its stores anew each time holds its
 * connections until the round is over, not until the test is — fifteen rounds of six were ninety
 * connections of one file at once, on a server that refuses at a hundred.
 */
export async function connectionsScopedTo<T>(body: () => Promise<T>): Promise<T> {
  const mark = opened.length;
  try {
    return await body();
  } finally {
    for (const connection of opened.splice(mark)) await connection.onDestroy();
  }
}

/** Thread ids `thread-1`, `thread-2`, … */
export class CountingIdGenerator extends IdGenerator {
  #threads = 0;
  #executions = 0;

  newThreadId(): string {
    this.#threads += 1;
    return `thread-${String(this.#threads)}`;
  }

  newExecutionId(): string {
    this.#executions += 1;
    return `execution-${String(this.#executions)}`;
  }
}

/** The thread ids of a test file's record stores: one counter, so no two tests share a thread. */
const fileIds = new CountingIdGenerator();

/** A record store on `url`, on `clock`. */
export function recordsOn(
  url: string,
  clock: VirtualClock = new VirtualClock(),
  ids: IdGenerator = fileIds,
): PostgresExecutionRecordRepository {
  return new PostgresExecutionRecordRepository(
    connectionTo(url),
    clock,
    new TestApplicationContext({}),
    ids,
  );
}

/** An outcome with `status`. */
export const outcomeOf = (
  status: ExecutionRecordStatus,
  fields: Partial<TurnOutcome> = {},
): TurnOutcome => ({
  replyWith: status === ExecutionRecordStatus.Answered ? "Done." : "",
  status,
  stopReason: "",
  route: ["start", "clerk"],
  steps: [{ agent: "clerk", content: "looked it up" }],
  costUsd: 0.01,
  ...fields,
});

/** A new record of `threadId`. */
export const recordOf = (
  threadId: string,
  status: ExecutionRecordStatus,
  fields: Partial<NewTurn> = {},
): NewTurn => ({
  ...outcomeOf(status),
  runId: "run-1",
  threadId,
  tenantId: "default",
  bundle: "desk-workflow",
  task: "where is order 7?",
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: "1.0.0",
  configHash: "hash",
  ...fields,
});
