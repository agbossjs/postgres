/**
 * agbossjs/agboss#789: the child queue's LISTEN notices a connection that dies silently — through a
 * TCP proxy that drops every byte with no FIN and no RST (`socket.destroy()` would be a FIN). The
 * instance warns within `postgresWatchLivenessSeconds` (a ping every half, an answer due in the
 * other half, on the clock), listens again on a new connection after the first pause, wakes once
 * (the catch-up), then hears the next save. A connection attempt that is swallowed gives up within
 * the bound and is retried.
 */
import type { ChildExecutionQueueWatch } from "@agboss/core";
import { ExecutionRecordStatus, LogLevel } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresChildExecutionQueueRepository, PostgresConnection } from "../../src/index.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const LIVENESS_SECONDS = 10;
/** How long a new connection may take in real time (a loaded machine): a hang bound, not an assertion. */
const CONNECTS = { timeout: 15_000 };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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

/** An instance whose store reaches the database through `proxy`, and the one that queues directly. */
async function instances(): Promise<{
  readonly proxy: BlackholeProxy;
  readonly clock: VirtualClock;
  readonly logger: RecordingLogger;
  readonly watched: PostgresChildExecutionQueueRepository;
  readonly direct: PostgresChildExecutionQueueRepository;
}> {
  const direct = new URL(database.url());
  const proxy = await BlackholeProxy.start({ host: direct.hostname, port: Number(direct.port) });
  cleanups.push(() => proxy.close());
  const through = new URL(direct);
  through.port = String(proxy.port);
  const connection = new PostgresConnection({
    url: through.toString(),
    poolSize: 2,
    watchLivenessSeconds: LIVENESS_SECONDS,
  });
  cleanups.push(() => connection.onDestroy());
  const clock = new VirtualClock();
  const logger = new RecordingLogger();
  const queueOn = (conn: PostgresConnection, id: string, log: RecordingLogger) =>
    new PostgresChildExecutionQueueRepository(conn, clock, new TestApplicationContext({}, id), log);
  return {
    proxy,
    clock,
    logger,
    watched: queueOn(connection, "instance-2", logger),
    direct: queueOn(connectionTo(database.url(), 2), "instance-1", new RecordingLogger()),
  };
}

/**
 * `seconds` of the clock in the two halves the watch's ping runs in: the ping goes out at the first
 * half and its answer is due at the second — a sleep made after a jump is due from the jump.
 */
async function advanceBound(clock: VirtualClock): Promise<void> {
  await clock.advance(seconds(LIVENESS_SECONDS / 2));
  await clock.advance(seconds(LIVENESS_SECONDS / 2));
}

async function watching(queue: PostgresChildExecutionQueueRepository) {
  let wakes = 0;
  const watch: ChildExecutionQueueWatch = await queue.watchQueued(() => {
    wakes += 1;
  });
  cleanups.push(() => watch.close());
  return { wakes: () => wakes };
}

describe("agbossjs/agboss#789: the child queue's LISTEN on a silently dead connection", () => {
  it("warns within the bound, listens again, wakes once and hears the next save", async () => {
    const { proxy, clock, logger, watched, direct } = await instances();
    const watch = await watching(watched);
    expect(logger.entries).toEqual([]);

    proxy.cut();
    await direct.saveIfAbsent(child("c-1"));
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    expect(logger.entries).toEqual([]);
    await clock.advance(seconds(LIVENESS_SECONDS / 2));

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      level: LogLevel.Warn,
      code: "child-queue.watch-connection-lost",
    });
    expect(watch.wakes()).toBe(0);

    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(1);
    }, CONNECTS);
    await direct.saveIfAbsent(child("c-2"));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(2);
    }, CONNECTS);
    // (the instance's pool holds a connection through the proxy that is cut as well: not the watch's)
    expect(await direct.claimFirstByStatusQueuedOrderByDepthDesc()).toMatchObject({
      executionId: "c-1",
    });
    expect(logger.entries).toHaveLength(1);
  });

  it("a connection attempt the network swallows gives up within the bound and is retried", async () => {
    const { proxy, clock, logger, watched } = await instances();
    const watch = await watching(watched);

    proxy.cut();
    proxy.swallowNew(true);
    await advanceBound(clock);
    expect(logger.entries).toHaveLength(1);
    await clock.advance(seconds(1));
    // the new connection is swallowed: nothing answers its startup, so it is dropped at the bound
    await clock.advance(seconds(LIVENESS_SECONDS));
    expect(watch.wakes()).toBe(0);

    proxy.swallowNew(false);
    await clock.advance(seconds(2));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(1);
    }, CONNECTS);
  });
});
