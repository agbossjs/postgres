import {
  A2ATaskSaveStatus,
  A2ATaskState,
  InvalidA2APageTokenError,
  type NewA2ATask,
} from "@agboss/core";
import { describe, expect, it } from "vitest";
import { PostgresA2ATaskRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/postgres#129: the A2A task store's clauses past the contract — what a save hands back
 * as the task it saved, the status a row's columns must agree on, the pending pauses a status
 * keeps, a page of none and a token no list gave, the store's descriptor and a lost connection.
 */
const database = testDatabase();

const NINE = new Date("2026-01-05T09:00:00.000Z");
const HASH = `sha256:${"cd".repeat(32)}`;

const tasksOn = (url = database.url()) => new PostgresA2ATaskRepository(connectionTo(url));

const newTask = (taskId: string, extra: Partial<NewA2ATask> = {}): NewA2ATask => ({
  tenantId: "acme",
  taskId,
  ownerId: "alice",
  contextId: "ctx-1",
  skill: "charge-workflow-start",
  status: { state: A2ATaskState.Submitted, pendingPauses: [] },
  acceptedAt: NINE,
  messageId: `m-${taskId}`,
  requestHash: "h-1",
  ...extra,
});

const keyOf = (taskId: string) => ({ tenantId: "acme", taskId });

/** Writes `status` over a saved task's row, as an older or a later version of the store left it. */
const overwritten = (taskId: string, state: string, status: unknown) =>
  onSchema(
    database.url(),
    `UPDATE agboss_a2a_tasks SET state = $3, status = $4::jsonb
     WHERE tenant_id = $1 AND task_id = $2`,
    ["acme", taskId, state, JSON.stringify(status)],
  );

describe("agbossjs/postgres#129: the A2A task store, clause by clause", () => {
  it("a save hands back the task with the caller's peer and body hash only when it had them", async () => {
    const tasks = tasksOn();

    const plain = await tasks.saveIfAbsent(newTask("plain"));
    const trusted = await tasks.saveIfAbsent(
      newTask("trusted", { callerPeer: "orders-application", meshBodyHash: HASH }),
    );

    expect(plain.status).toBe(A2ATaskSaveStatus.Saved);
    expect(plain).not.toHaveProperty("task.callerPeer");
    expect(plain).not.toHaveProperty("task.meshBodyHash");
    expect(trusted.status).toBe(A2ATaskSaveStatus.Saved);
    expect(trusted).toMatchObject({
      task: { callerPeer: "orders-application", meshBodyHash: HASH },
    });
  });

  it("a row whose state column and status disagree is refused, naming the task", async () => {
    const tasks = tasksOn();
    await tasks.saveIfAbsent(newTask("split"));
    await overwritten("split", A2ATaskState.Working, {
      state: A2ATaskState.Completed,
      pendingPauses: [],
    });

    await expect(tasks.findById(keyOf("split"))).rejects.toThrow(
      "agboss_a2a_tasks row split: its state column and its status disagree",
    );
  });

  it.each([
    ["a kind no pause has", "bogus-kind", { pauseId: "p-1", kind: "bogus", ask: {} }],
    ["no kind", "no-kind", { pauseId: "p-1", ask: {} }],
    ["a pause id that is no text", "bad-id", { pauseId: 7, kind: "approval", ask: {} }],
  ])("a status with a pending pause of %s is refused", async (_name, id, pause) => {
    const tasks = tasksOn();
    await tasks.saveIfAbsent(newTask(id));
    await overwritten(id, A2ATaskState.InputRequired, {
      state: A2ATaskState.InputRequired,
      pendingPauses: [pause],
    });

    await expect(tasks.findById(keyOf(id))).rejects.toThrow();
  });

  it("a page of no tasks has no next token, however many tasks match; a token no list gave is refused", async () => {
    const tasks = tasksOn();
    const tenantId = "paged";
    await tasks.saveIfAbsent(newTask("one", { tenantId }));
    await tasks.saveIfAbsent(newTask("two", { tenantId }));
    const query = { tenantId, ownerId: "alice" } as const;

    expect(await tasks.list({ ...query, pageSize: 0 })).toEqual({
      tasks: [],
      nextPageToken: "",
      totalSize: 2,
    });
    for (const token of ["!", Buffer.from("not json").toString("base64url")])
      await expect(tasks.list({ ...query, pageSize: 1, pageToken: token })).rejects.toBeInstanceOf(
        InvalidA2APageTokenError,
      );
  });

  it("the store is a PostgreSQL one, and a lost connection rejects ping", async () => {
    expect(PostgresA2ATaskRepository.store).toEqual({ backend: "postgres" });

    await expect(tasksOn("postgres://postgres:pw@127.0.0.1:1/postgres").ping()).rejects.toThrow();
  });
});
