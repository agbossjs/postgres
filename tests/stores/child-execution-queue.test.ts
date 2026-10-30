import { ExecutionRecordStatus, type QueuedChildExecution } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { PostgresChildExecutionQueueRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { TestApplicationContext } from "../support/application-context.js";
import { connectionTo } from "../support/stores.js";

/** AC2 at the store: two claimers racing over many queued children, each child claimed once. */
const database = testDatabase();

const queueOf = (instanceId: string): PostgresChildExecutionQueueRepository =>
  new PostgresChildExecutionQueueRepository(
    connectionTo(database.url(), 3),
    new VirtualClock(),
    new TestApplicationContext({}, instanceId),
  );

const child = (index: number): QueuedChildExecution => ({
  tenantId: "default",
  executionId: `child-${String(index)}`,
  rootExecutionId: "root-1",
  parentExecutionId: "root-1",
  rootWorkflow: "items-workflow",
  workflow: "item-workflow",
  depth: 2 + (index % 3),
  status: ExecutionRecordStatus.Queued,
  run: "{}",
  queuedAt: new Date(Date.UTC(2026, 0, 5, 9, 0, index)),
});

/** Claims until the queue is empty, several claims in flight at once; the ids claimed. */
async function claimAll(queue: PostgresChildExecutionQueueRepository): Promise<string[]> {
  const claimed: string[] = [];
  for (;;) {
    const batch = await Promise.all(
      [1, 2, 3].map(() => queue.claimFirstByStatusQueuedOrderByDepthDesc()),
    );
    const found = batch.filter((one) => one !== undefined);
    claimed.push(...found.map((one) => one.executionId));
    if (found.length === 0) return claimed;
  }
}

describe("PostgresChildExecutionQueueRepository: FOR UPDATE SKIP LOCKED", () => {
  it("two instances, three claims each in flight: every child claimed exactly once", async () => {
    const first = queueOf("instance-1");
    const second = queueOf("instance-2");
    const children = Array.from({ length: 40 }, (_, index) => child(index));
    await Promise.all(children.map((one) => first.saveIfAbsent(one)));

    const [byFirst, bySecond] = await Promise.all([claimAll(first), claimAll(second)]);

    const all = [...byFirst, ...bySecond].sort();
    expect(all).toEqual(children.map((one) => one.executionId).sort());
    expect(new Set(all).size).toBe(40);
    const stored = await first.findByTenantIdAndExecutionId(
      "default",
      bySecond[0] ?? byFirst[0] ?? "",
    );
    expect(stored).toMatchObject({ status: ExecutionRecordStatus.Running });
  });

  it("a lost connection rejects the claim", async () => {
    const queue = new PostgresChildExecutionQueueRepository(
      connectionTo("postgres://postgres:pw@127.0.0.1:1/postgres"),
      new VirtualClock(),
      new TestApplicationContext({}),
    );

    await expect(queue.claimFirstByStatusQueuedOrderByDepthDesc()).rejects.toThrow();
  });
});
