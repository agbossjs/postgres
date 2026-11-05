/**
 * agbossjs/agboss#777: the child queue's watch on PostgreSQL — a `LISTEN` on a connection of its
 * own. It passes on only its own schema's notifications; a connection killed is opened again after
 * a pause on the clock and wakes once (a notification sent meanwhile is lost — the catch-up and the
 * sweep cover it), then hears the next save; `close()` ends its connection; on an empty queue the
 * connection sits idle on its `LISTEN`, nothing run.
 */
import type { ChildExecutionQueueWatch } from "@agboss/core";
import { ExecutionRecordStatus } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { minutes, seconds } from "@agboss/core/units";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresChildExecutionQueueRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, serverUrl, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const clock = new VirtualClock();
const watches: ChildExecutionQueueWatch[] = [];

afterEach(async () => {
  for (const watch of watches.splice(0)) await watch.close();
});

/** The test schema's URL with an application name of its own: its listener's backend is found by it. */
const namedUrl = (): string => {
  const url = new URL(database.url());
  url.searchParams.set("application_name", database.schema());
  return url.toString();
};

const queueOf = (instanceId: string): PostgresChildExecutionQueueRepository =>
  new PostgresChildExecutionQueueRepository(
    connectionTo(namedUrl(), 2),
    clock,
    new TestApplicationContext({}, instanceId),
  );

const child = (executionId: string) => ({
  tenantId: "default",
  executionId,
  rootExecutionId: "root-1",
  parentExecutionId: "root-1",
  rootWorkflow: "items-workflow",
  workflow: "item-workflow",
  depth: 2,
  status: ExecutionRecordStatus.Queued,
  run: "{}",
  queuedAt: new Date("2026-01-05T09:00:00Z"),
});

/** A watch on `queue` and how many times it woke. */
async function watching(
  queue: PostgresChildExecutionQueueRepository,
): Promise<{ readonly wakes: () => number }> {
  let wakes = 0;
  watches.push(
    await queue.watchQueued(() => {
      wakes += 1;
    }),
  );
  return { wakes: () => wakes };
}

interface Backend {
  readonly pid: number;
  readonly state: string;
  readonly query: string;
  readonly state_change: Date;
}

/** The listening backends of this file's schema. */
const listenersNow = async (): Promise<Backend[]> =>
  (
    await onSchema(
      database.url(),
      `SELECT pid, state, query, state_change FROM pg_stat_activity
       WHERE application_name = $1 AND query LIKE 'LISTEN %'`,
      [database.schema()],
    )
  ).rows as Backend[];

/** `sql` on a connection of its own, outside the test schema. */
async function onServer(sql: string, parameters: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl() });
  await client.connect();
  try {
    await client.query(sql, parameters);
  } finally {
    await client.end();
  }
}

describe("agbossjs/agboss#777: the child queue's LISTEN", () => {
  it("passes on its own schema's notifications only", async () => {
    const watch = await watching(queueOf("instance-2"));

    await onServer(
      "SELECT pg_notify('agboss_child_queued', 'another_schema'), pg_notify('agboss_child_queued', $1)",
      [database.schema()],
    );

    await vi.waitFor(() => {
      expect(watch.wakes()).toBeGreaterThan(0);
    });
    expect(watch.wakes()).toBe(1);
  });

  it("a killed connection listens again after a pause, wakes once, then hears the next save", async () => {
    const queue = queueOf("instance-2");
    const watch = await watching(queue);
    const [backend] = await listenersNow();
    expect(backend).toBeDefined();

    await onServer("SELECT pg_terminate_backend($1)", [backend?.pid]);
    await vi.waitFor(async () => {
      await clock.advance(seconds(1));
      expect(watch.wakes()).toBe(1);
    });
    const [again] = await listenersNow();
    expect(again?.pid).not.toBe(backend?.pid);

    await queueOf("instance-1").saveIfAbsent(child("c-1"));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(2);
    });
    expect(await queue.claimFirstByStatusQueuedOrderByDepthDesc()).toMatchObject({
      executionId: "c-1",
    });
  });

  it("idle on an empty queue: one connection on its LISTEN, nothing run while time passes", async () => {
    await watching(queueOf("instance-2"));
    const [before] = await listenersNow();

    await clock.advance(minutes(10));

    expect(await listenersNow()).toEqual([before]);
    expect(before).toMatchObject({ state: "idle", query: "LISTEN agboss_child_queued" });
  });

  it("close() ends its connection", async () => {
    const queue = queueOf("instance-2");
    const watch = await queue.watchQueued(() => undefined);
    expect(await listenersNow()).toHaveLength(1);

    await watch.close();

    await vi.waitFor(async () => {
      expect(await listenersNow()).toEqual([]);
    });
  });
});
