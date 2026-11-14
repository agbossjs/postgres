/**
 * agbossjs/agboss#954 — an application's stop against a PostgreSQL server gone quiet (`docker
 * pause`: sockets open, nothing answered): `close({ timeout })` ends, no connection to the server
 * is left open (the pool's clients that wait for a statement, the child queue's LISTEN
 * connection), and nothing names `PostgresConnection.onDestroy` as a call the stop gave up on.
 * Connections are counted by their sockets (`destroyed`). The server is a container of the test's
 * own (`tests/support/pause.ts`); without Docker, skipped.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { migratePostgres, PostgresConnection } from "../../src/index.js";
import { listenerOf } from "../../src/connection/postgres-connection.js";
import {
  HAS_DOCKER,
  type PausableServer,
  RealClock,
  sleep,
  startPostgres,
  trackSockets,
  watchUnhandled,
} from "../support/pause.js";
import { StopApplication, StopBatchStart } from "../fixtures/stop/stop.application.js";

let server: PausableServer;
beforeAll(async () => {
  if (!HAS_DOCKER) return;
  server = await startPostgres();
  await migratePostgres({ url: server.url });
  process.env["AGBOSS_STOP_DATABASE_URL"] = server.url;
  process.env["AGBOSS_STOP_OPENROUTER_KEY"] = "placeholder";
}, 120_000);
afterEach(() => {
  if (HAS_DOCKER) server.unpause();
});
afterAll(() => {
  if (HAS_DOCKER) server.remove();
});

async function closedAgainstPausedServer(running: boolean): Promise<{
  readonly open: number;
  readonly unhandled: unknown[];
}> {
  const port = Number(new URL(server.url).port);
  const unhandled = watchUnhandled();
  const sockets = trackSockets(port);
  try {
    const app = await createApp(StopApplication, { env: "stop" });
    if (running) {
      app
        .execute(StopBatchStart, [{ name: "a" }, { name: "b" }] as never)
        .catch((): undefined => undefined);
      await sleep(1500);
    }
    await sleep(500);
    server.pause();
    await sleep(1000);

    await app.close({ timeout: seconds(5) });
    const open = sockets.open();
    server.unpause();
    await sleep(500);
    return { open, unhandled: unhandled.seen };
  } finally {
    sockets.stop();
    unhandled.stop();
    server.unpause();
  }
}

describe.skipIf(!HAS_DOCKER)(
  "#954: close() against a paused PostgreSQL leaves no connection open",
  () => {
    it("an idle application: every socket to the server is destroyed when close() returns", async () => {
      const { open, unhandled } = await closedAgainstPausedServer(false);

      expect(open).toBe(0);
      expect(unhandled).toEqual([]);
    }, 60_000);

    it("with executions running (statements in flight): every socket is destroyed when close() returns", async () => {
      const { open, unhandled } = await closedAgainstPausedServer(true);

      expect(open).toBe(0);
      expect(unhandled).toEqual([]);
    }, 60_000);
  },
);

describe.skipIf(!HAS_DOCKER)("#954: a listener that reconnects while the connection stops", () => {
  /** A listener on a connection with a 2 s liveness bound, the server then paused until it is lost. */
  async function lostListener(): Promise<{
    readonly connection: PostgresConnection;
    readonly sockets: ReturnType<typeof trackSockets>;
  }> {
    const connection = new PostgresConnection({ url: server.url, watchLivenessSeconds: 2 });
    let lost = false;
    const sockets = trackSockets(Number(new URL(server.url).port));
    await listenerOf(connection, {
      channel: "i954_channel",
      payload: "i954",
      clock: new RealClock(),
      warn: () => {
        lost = true;
      },
      onNotify: () => undefined,
    });
    server.pause();
    for (let waited = 0; !lost && waited < 10_000; waited += 100) await sleep(100);
    expect(lost).toBe(true);
    return { connection, sockets };
  }

  it("the connection stops while the listener's new connection is opening: its socket is destroyed", async () => {
    const unhandled = watchUnhandled();
    const { connection, sockets } = await lostListener();
    try {
      await sleep(1500); // past the 1 s pause: the new connection is opening to the quiet server

      await connection.onDestroy();
      await sleep(300);

      expect(sockets.open()).toBe(0);
      expect(unhandled.seen).toEqual([]);
    } finally {
      sockets.stop();
      unhandled.stop();
      server.unpause();
    }
  }, 60_000);

  it("the connection stops before the pause ends: the listener does not reconnect, no listener is handed out", async () => {
    const { connection, sockets } = await lostListener();
    try {
      await connection.onDestroy();
      await sleep(2500); // past the pause: the listener would try again

      await expect(
        listenerOf(connection, {
          channel: "i954_channel",
          payload: "i954",
          clock: new RealClock(),
          warn: () => undefined,
          onNotify: () => undefined,
        }),
      ).rejects.toMatchObject({ code: "postgres.connection-closed" });
      expect(sockets.open()).toBe(0);
    } finally {
      sockets.stop();
      server.unpause();
    }
  }, 60_000);
});
