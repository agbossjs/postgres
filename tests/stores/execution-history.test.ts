import { ComponentKind, ExecutionHistoryStatus, type ExecutionHistoryRecord } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { PostgresExecutionHistoryRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * The history's edges beyond the contract: the same root saved twice keeps one row — its columns
 * moved with it, so a paused record that ended is swept —, ids of one start are ordered byte-wise,
 * a tenant's period is paged, a row that is not a record is refused, and a lost connection rejects.
 */
const database = testDatabase();

const historyOn = (url = database.url()) =>
  new PostgresExecutionHistoryRepository(connectionTo(url));

const NINE = "2026-01-05T09:00:00.000Z";

const recordOf = (
  executionId: string,
  fields: Partial<ExecutionHistoryRecord> = {},
): ExecutionHistoryRecord => ({
  path: ["desk-workflow-start", "desk-workflow-finish"],
  scope: [],
  outdatedValues: [],
  spend: {
    totalUsd: 0,
    calls: 0,
    cacheReadTokens: 0,
    byCaller: {},
    byCategory: {
      agents: 0,
      routing: 0,
      guards: 0,
      review: 0,
      tools: 0,
      compaction: 0,
      retrieval: 0,
    },
    byModel: {},
    trace: [],
  },
  children: [],
  pauses: [],
  compensations: [],
  toolCalls: [],
  steps: [],
  executionId,
  rootExecutionId: executionId,
  threadId: "thread-1",
  tenantId: "acme",
  application: { name: "desk-application", version: "1.0.0", instanceId: "instance-1" },
  workflow: { name: "desk-workflow", version: "1.0.0", startedVersion: "1.0.0", configHash: "c" },
  status: ExecutionHistoryStatus.Finished,
  startedAt: NINE,
  // a record resting at a pause has not ended
  ...(fields.status === ExecutionHistoryStatus.Paused
    ? {}
    : { endedAt: "2026-01-05T09:00:05.000Z" }),
  start: {
    name: "desk-workflow-start",
    kind: ComponentKind.WorkflowStart,
    promptHash: "",
    schemaHash: "",
  },
  input: { text: "where is order 7?", count: 7, nested: [{ deep: true }] },
  contexts: { tenant: { tenantId: "acme" }, execution: {} },
  ...fields,
});

const DAY = {
  from: new Date("2026-01-05T00:00:00.000Z"),
  to: new Date("2026-01-06T00:00:00.000Z"),
};

const idsOf = (records: readonly ExecutionHistoryRecord[]): string[] =>
  records.map((record) => record.executionId);

describe("PostgresExecutionHistoryRepository", () => {
  it("the same root saved twice is one row, the last save's: its thread, its end and its record", async () => {
    const [first, second] = [historyOn(), historyOn()];
    const paused = recordOf("twice", { status: ExecutionHistoryStatus.Paused });
    await first.save(paused);
    await second.save(recordOf("twice", { threadId: "thread-9" }));

    const rows = await onSchema(
      database.url(),
      "SELECT thread_id, ended_at FROM agboss_execution_history WHERE execution_id = 'twice'",
    );
    expect(rows.rows).toEqual([
      { thread_id: "thread-9", ended_at: new Date("2026-01-05T09:00:05.000Z") },
    ]);
    expect(await first.findByTenantIdAndExecutionId("acme", "twice")).toEqual(
      recordOf("twice", { threadId: "thread-9" }),
    );
    expect(await first.findAllByTenantIdAndThreadId("acme", "thread-1")).toEqual([]);
  });

  it("a paused record that ended later is swept once its end is before the cutoff", async () => {
    const history = historyOn();
    const paused = recordOf("ended-later", { status: ExecutionHistoryStatus.Paused });
    await history.save(paused);
    await history.deleteByEndedAtBefore(new Date("2026-02-01T00:00:00.000Z"));
    expect(await history.findAllByExecutionId("ended-later")).toHaveLength(1);

    await history.save(recordOf("ended-later"));
    await history.deleteByEndedAtBefore(new Date("2026-02-01T00:00:00.000Z"));

    expect(await history.findAllByExecutionId("ended-later")).toEqual([]);
  });

  it("records of one start are ordered by id byte-wise, whatever the database's collation", async () => {
    const history = historyOn();
    for (const id of ["order-b", "order-a", "order-B"])
      await history.save(recordOf(id, { tenantId: "collation", threadId: "thread-c" }));

    expect(idsOf(await history.findAllByTenantIdAndThreadId("collation", "thread-c"))).toEqual([
      "order-B",
      "order-a",
      "order-b",
    ]);
  });

  it("a tenant's period in pages: an offset past the end gives nothing, a start at its end is out", async () => {
    const history = historyOn();
    const at = (hour: string) => `2026-01-05T${hour}:00:00.000Z`;
    for (const [id, hour] of [
      ["page-1", "01"],
      ["page-2", "02"],
      ["page-3", "03"],
    ] as const)
      await history.save(recordOf(id, { tenantId: "paged", startedAt: at(hour) }));
    await history.save(
      recordOf("page-next-day", { tenantId: "paged", startedAt: DAY.to.toISOString() }),
    );

    const page = (offset: number, limit: number) =>
      history.findAllByTenantIdAndStartedAtBetween("paged", DAY.from, DAY.to, { offset, limit });

    expect(idsOf(await page(0, 2))).toEqual(["page-1", "page-2"]);
    expect(idsOf(await page(2, 2))).toEqual(["page-3"]);
    expect(await page(3, 2)).toEqual([]);
  });

  it("a row that is not a history record is refused when read, never handed to the framework", async () => {
    const history = historyOn();
    await onSchema(
      database.url(),
      `INSERT INTO agboss_execution_history
         (tenant_id, execution_id, thread_id, started_at, record)
       VALUES ('acme', 'bad', 'thread-bad', now(), $1::jsonb)`,
      [JSON.stringify({ ...recordOf("bad"), status: "lost" })],
    );

    await expect(history.findByTenantIdAndExecutionId("acme", "bad")).rejects.toThrow(
      /not readable/u,
    );
    await expect(history.findAllByExecutionId("bad")).rejects.toThrow(/not readable/u);
  });

  it("a lost connection rejects ping, the save, every read and the sweep", async () => {
    const down = historyOn("postgres://postgres:pw@127.0.0.1:1/postgres");
    const page = { offset: 0, limit: 1 };

    await expect(down.ping()).rejects.toThrow();
    await expect(down.save(recordOf("down"))).rejects.toThrow();
    await expect(down.findByTenantIdAndExecutionId("acme", "down")).rejects.toThrow();
    await expect(down.findAllByExecutionId("down")).rejects.toThrow();
    await expect(down.findAllByTenantIdAndThreadId("acme", "t")).rejects.toThrow();
    await expect(
      down.findAllByTenantIdAndStartedAtBetween("acme", DAY.from, DAY.to, page),
    ).rejects.toThrow();
    await expect(down.findAllByStartedAtBetween(DAY.from, DAY.to, page)).rejects.toThrow();
    await expect(down.deleteByEndedAtBefore(DAY.to)).rejects.toThrow();
  });
});
