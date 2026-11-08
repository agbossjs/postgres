import { A2ATaskState, type A2ATaskStatus, type NewA2ATask } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresA2ATaskRepository } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { freshSchema, onSchema, testDatabase } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#810: what the mesh keeps on an A2A task — the first message's `meshBodyHash`
 * (column `mesh_body_hash`, migration 0028), a refusal's `errorDetails` and a completion's
 * `spentUsd` (in the status's jsonb) — comes back as written on another instance; a task saved
 * before 0028 reads as untrusted (no body hash, so no run report); and a status this store cannot
 * read in full is refused, never read with a field dropped.
 */
const database = testDatabase();

const NINE = new Date("2026-01-05T09:00:00.000Z");
const HASH = `sha256:${"ab".repeat(32)}`;

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

describe("agbossjs/agboss#810: the mesh's fields of an A2A task on PostgreSQL", () => {
  it("the body hash, a refusal's facts and a completion's spend round-trip between instances", async () => {
    const [a, b] = [tasksOn(), tasksOn()];
    const rejected: A2ATaskStatus = {
      state: A2ATaskState.Rejected,
      pendingPauses: [],
      errorCode: "limit.hops",
      message: "the task was rejected: limit.hops",
      errorDetails: { chain: [{ application: "orders-application" }], maxMeshHops: 1 },
    };
    const completed: A2ATaskStatus = {
      state: A2ATaskState.Completed,
      pendingPauses: [],
      finish: "charged-workflow-finish",
      output: { chargeId: "ch-1" },
      spentUsd: 0.000123,
    };
    await a.saveIfAbsent(
      newTask("trusted", { callerPeer: "orders-application", meshBodyHash: HASH }),
    );
    await a.saveIfAbsent(newTask("refused", { status: rejected }));
    await a.compareAndSetStatus(keyOf("trusted"), 1, completed, NINE);

    const trusted = await b.findById(keyOf("trusted"));
    expect(trusted).toMatchObject({ meshBodyHash: HASH, status: completed, version: 2 });
    expect((await b.findById(keyOf("refused")))?.status).toEqual(rejected);
    const listed = await b.list({ tenantId: "acme", ownerId: "alice", pageSize: 10 });
    expect(listed.tasks.find((task) => task.taskId === "trusted")?.meshBodyHash).toBe(HASH);
  });

  it("a task of before migration 0028 reads with no body hash: untrusted, no run report", async () => {
    const url = await freshSchema();
    await migrateWith(
      { url },
      migrationsIn(
        migrationsFolder({
          "0028_a2a_task_mesh_body_hash.sql": null,
          "0029_execution_lease_token.sql": null,
        }),
      ),
    );
    await onSchema(
      url,
      `INSERT INTO agboss_a2a_tasks (tenant_id, task_id, owner_id, context_id, skill, state, status,
         version, accepted_at, status_at, caller_peer)
       VALUES ('acme', 'old', 'alice', 'ctx-0', 'charge-workflow-start', 'TASK_STATE_COMPLETED',
         '{"state":"TASK_STATE_COMPLETED","pendingPauses":[],"spentUsd":1}', 1, $1, $1,
         'orders-application')`,
      [NINE],
    );

    expect((await migratePostgres({ url })).applied.map((file) => file.version)).toEqual([28]);

    const old = await tasksOn(url).findById(keyOf("old"));
    expect(old).toMatchObject({ callerPeer: "orders-application", status: { spentUsd: 1 } });
    expect(old).not.toHaveProperty("meshBodyHash");
  });

  it.each([
    ["a field it does not know", "unknown", { pendingPauses: [], grantedUsd: 5 }],
    ["a negative spend", "negative", { pendingPauses: [], spentUsd: -1 }],
    ["a spend that is no number", "text", { pendingPauses: [], spentUsd: "3" }],
  ])("a status with %s is refused, never read without it", async (_name, id, fields) => {
    const tasks = tasksOn();
    await tasks.saveIfAbsent(newTask(id));
    const status = { state: A2ATaskState.Completed, ...fields };
    await onSchema(
      database.url(),
      `UPDATE agboss_a2a_tasks SET state = $3, status = $4::jsonb
       WHERE tenant_id = $1 AND task_id = $2`,
      ["acme", id, A2ATaskState.Completed, JSON.stringify(status)],
    );

    await expect(tasks.findById(keyOf(id))).rejects.toThrow();
  });
});
