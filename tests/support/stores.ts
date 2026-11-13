import { ExecutionRecordStatus, IdGenerator, type NewTurn, type TurnOutcome } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { afterEach } from "vitest";
import { PostgresConnection, PostgresExecutionRecordRepository } from "../../src/index.js";
import { TestApplicationContext } from "./application-context.js";

/** The connections a test opened, ended after it. */
const opened: PostgresConnection[] = [];

/**
 * The most connections a test file's pools may hold open at once (agbossjs/agboss#978 AC1): the
 * run's files go on in parallel, the server's `max_connections` is 100 — a file that needs more
 * ends a round's pools (`endConnections`) before it opens the next round's.
 */
export const FILE_CONNECTION_BUDGET = 12;

/** Ends every connection this test opened so far (a test with rounds ends each round's). */
export async function endConnections(): Promise<void> {
  for (const connection of opened.splice(0)) await connection.onDestroy();
}

afterEach(endConnections);

/** A connection of this test to `url` (ended after the test, or by `endConnections`). */
export function connectionTo(url: string, poolSize = 4): PostgresConnection {
  const held = opened.reduce((sum, open) => sum + open.pool.options.max, 0);
  if (held + poolSize > FILE_CONNECTION_BUDGET)
    throw new Error(
      `a test file's pools would hold ${String(held + poolSize)} connections, over its budget of ${String(FILE_CONNECTION_BUDGET)}: end a round's before the next (endConnections)`,
    );
  const connection = new PostgresConnection({ url, poolSize });
  opened.push(connection);
  return connection;
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
