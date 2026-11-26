/**
 * agbossjs/agboss#1129: `close()` of the child queue's LISTEN waits for a reconnect in flight. The
 * connection was lost, the pause went by, and the new connection is still starting (the network
 * swallows it): a `close()` that did not wait would resolve at once and leave that connection —
 * and the `LISTEN` it is about to run — alive after the instance stopped, and a wake after the close.
 */
import { ExecutionRecordStatus, type ChildExecutionQueueWatch } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { Socket } from "node:net";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresChildExecutionQueueRepository, PostgresConnection } from "../../src/index.js";
import { TimedClient } from "../../src/connection/timed-client.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const LIVENESS_SECONDS = 10;
const CONNECTS = { timeout: 15_000 };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

/** `pg`'s own connection of a client: its socket and whether it asked for TCP keepalive. */
function internals(client: pg.Client): { stream: Socket; keepAlive: boolean } {
  const connection: unknown = Reflect.get(client, "connection");
  const stream: unknown = Reflect.get(Object(connection), "stream");
  if (!(stream instanceof Socket)) throw new Error("pg's connection has no socket");
  return { stream, keepAlive: Reflect.get(Object(connection), "_keepAlive") === true };
}
const socketOf = (client: pg.Client): Socket => internals(client).stream;

/** The `pg` clients made from now on, each with the socket the listener gave it. */
function trackClients(): pg.Client[] {
  const made: pg.Client[] = [];
  const connect = Object.getOwnPropertyDescriptor(pg.Client.prototype, "connect")?.value as (
    this: pg.Client,
    ...args: unknown[]
  ) => unknown;
  vi.spyOn(pg.Client.prototype, "connect").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    // the listener's own (TCP keepalive on), not a pool's (a `TimedClient`, agbossjs/agboss#928)
    if (internals(this).keepAlive && !(this instanceof TimedClient)) made.push(this);
    return connect.call(this, ...args) as never;
  });
  return made;
}

describe("agbossjs/agboss#1129: close() waits for a reconnect in flight", () => {
  it("AC6: the new connection is still starting at the close: it is dropped when close() resolves, and nothing wakes after", async () => {
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
    const watched = new PostgresChildExecutionQueueRepository(
      connection,
      clock,
      new TestApplicationContext("instance-2"),
      logger,
    );
    const queued = new PostgresChildExecutionQueueRepository(
      connectionTo(database.url(), 2),
      clock,
      new TestApplicationContext("instance-1"),
      new RecordingLogger(),
    );
    const clients = trackClients();
    let wakes = 0;
    const watch: ChildExecutionQueueWatch = await watched.watchQueued(() => {
      wakes += 1;
    });
    cleanups.push(() => watch.close());
    expect(clients).toHaveLength(1);

    // the connection is lost; the pause goes by; the new connection is swallowed: the reconnect is in flight
    proxy.cut();
    proxy.swallowNew(true);
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    expect(logger.entries).toHaveLength(1);
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(clients).toHaveLength(2);
    }, CONNECTS);

    await watch.close();

    // at the moment close() resolved, every connection the listener made is dropped
    expect(clients.map((client) => socketOf(client).destroyed)).toEqual([true, true]);
    proxy.swallowNew(false);
    await clock.advance(seconds(60));
    await queued.saveIfAbsent(child("after-close"));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(wakes).toBe(0);
    expect(clients).toHaveLength(2);
  }, 60_000);
});
