import { ExecutionRecordStatus, type QueuedChildExecution } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresChildExecutionQueueRepository } from "../../src/index.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { TestApplicationContext } from "../support/application-context.js";
import { freshSchema, onSchema } from "../support/database.js";
import { connectionTo } from "../support/stores.js";
import { blockedBefore, openTransaction, pidOf } from "./pause-locks.js";

/**
 * Each clause of the queue's statements a test proves (agbossjs/agboss#1302): dropping it from the
 * statement, one at a time, fails one of these. A schema of its own per test: a claim takes the
 * first queued child of the whole table.
 */
const queueOn = (url: string): PostgresChildExecutionQueueRepository =>
  new PostgresChildExecutionQueueRepository(
    connectionTo(url),
    new VirtualClock(),
    new TestApplicationContext({}, "instance-clauses"),
    new RecordingLogger(),
  );

const migrated = async (): Promise<string> => {
  const url = await freshSchema();
  await migratePostgres({ url });
  return url;
};

const child = (
  executionId: string,
  overrides: Partial<QueuedChildExecution> = {},
): QueuedChildExecution => ({
  tenantId: "default",
  executionId,
  rootExecutionId: "root-1",
  parentExecutionId: "root-1",
  rootWorkflow: "items-workflow",
  workflow: "item-workflow",
  depth: 2,
  status: ExecutionRecordStatus.Queued,
  run: "{}",
  queuedAt: new Date("2026-01-05T09:00:00.000Z"),
  ...overrides,
});

describe("PostgresChildExecutionQueueRepository: its statements' clauses", () => {
  it("a paused child queued again keeps nothing of its last run: no claim, no end, no failure", async () => {
    const url = await migrated();
    const queue = queueOn(url);
    await queue.saveIfAbsent(child("resumed"));
    await queue.claimFirstByStatusQueuedOrderByDepthDesc();
    await queue.completeByTenantIdAndExecutionId("default", "resumed", {
      status: ExecutionRecordStatus.Paused,
      failure: "left over",
    });

    const queued = await queue.saveIfAbsent(child("resumed"));

    expect(queued).toBe(true);
    const read = await queue.findByTenantIdAndExecutionId("default", "resumed");
    expect(read).toMatchObject({ status: ExecutionRecordStatus.Queued });
    expect(read?.instanceId).toBeUndefined();
    expect(read?.claimedAt).toBeUndefined();
    expect(read?.endedAt).toBeUndefined();
    expect(read?.failure).toBeUndefined();
  });

  it("a claim marks the child of its own tenant only: another tenant's one id stays queued", async () => {
    const url = await migrated();
    const queue = queueOn(url);
    await queue.saveIfAbsent(child("same-id", { tenantId: "tenant-a" }));
    await queue.saveIfAbsent(child("same-id", { tenantId: "tenant-b" }));

    await queue.claimFirstByStatusQueuedOrderByDepthDesc();

    const { rows } = await onSchema(
      url,
      "SELECT status FROM agboss_child_execution_queue ORDER BY status",
    );
    expect(rows).toEqual([{ status: "queued" }, { status: "running" }]);
  });

  it("finds a child of its own tenant only", async () => {
    const queue = queueOn(await migrated());
    await queue.saveIfAbsent(child("same-id", { tenantId: "tenant-a" }));

    expect(await queue.findByTenantIdAndExecutionId("tenant-b", "same-id")).toBeUndefined();
    expect(await queue.findByTenantIdAndExecutionId("tenant-a", "same-id")).toBeDefined();
  });

  it("completes the running child it names, of its tenant: no other running child is ended", async () => {
    const url = await migrated();
    const queue = queueOn(url);
    for (const [tenantId, executionId] of [
      ["tenant-a", "one"],
      ["tenant-a", "two"],
      ["tenant-b", "one"],
    ] as const) {
      await queue.saveIfAbsent(child(executionId, { tenantId }));
      await queue.claimFirstByStatusQueuedOrderByDepthDesc();
    }

    const done = await queue.completeByTenantIdAndExecutionId("tenant-a", "one", {
      status: ExecutionRecordStatus.Answered,
    });

    expect(done).toBe(true);
    const { rows } = await onSchema(
      url,
      "SELECT tenant_id, execution_id, status FROM agboss_child_execution_queue ORDER BY 1, 2",
    );
    expect(rows).toEqual([
      { tenant_id: "tenant-a", execution_id: "one", status: ExecutionRecordStatus.Answered },
      { tenant_id: "tenant-a", execution_id: "two", status: ExecutionRecordStatus.Running },
      { tenant_id: "tenant-b", execution_id: "one", status: ExecutionRecordStatus.Running },
    ]);
  });

  it("a claim passes over a row another claimer holds locked: it never waits for it", async () => {
    const url = await migrated();
    const queue = queueOn(url);
    await queue.saveIfAbsent(child("held", { depth: 3 }));
    await queue.saveIfAbsent(child("free", { depth: 2 }));
    const holder = await openTransaction(url);
    try {
      await holder.query(
        "SELECT 1 FROM agboss_child_execution_queue WHERE execution_id = 'held' FOR UPDATE",
      );
      const claim = queue.claimFirstByStatusQueuedOrderByDepthDesc();

      const waited = await blockedBefore(url, await pidOf(holder), claim);

      await holder.query("ROLLBACK");
      expect(waited).toBe(false);
      expect(await claim).toMatchObject({ executionId: "free" });
    } finally {
      await holder.end();
    }
  });
});
