/**
 * agbossjs/agboss#923 — an instance's stop ends while the PostgreSQL server has gone quiet (`docker
 * pause`: sockets open, nothing answered): `PostgresConnection.onDestroy` does not wait for
 * `pool.end()`, which waits for a statement in flight; nothing rejects unhandled when the server
 * comes back. The server is a container of the test's own (`tests/support/pause.ts`); without Docker, skipped.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresConnection } from "../../src/index.js";
import {
  endsWithin,
  HAS_DOCKER,
  type PausableServer,
  sleep,
  startPostgres,
  watchUnhandled,
} from "../support/pause.js";

/** Longer than the close's grace, far shorter than a stop's timeout. */
const MARGIN_MS = 4000;

let server: PausableServer;
beforeAll(async () => {
  server = await startPostgres();
}, 120_000);
afterEach(() => {
  server.unpause();
});
afterAll(() => {
  server.remove();
});

async function connected(): Promise<PostgresConnection> {
  const connection = new PostgresConnection({ url: server.url });
  await connection.ping();
  return connection;
}

describe.skipIf(!HAS_DOCKER)("#923: onDestroy against a paused PostgreSQL", () => {
  it("idle: onDestroy returns, no unhandled rejection after the unpause", async () => {
    const unhandled = watchUnhandled();
    const connection = await connected();
    server.pause();
    await sleep(500);

    const outcome = await endsWithin(connection.onDestroy(), MARGIN_MS);
    server.unpause();
    await sleep(2000);
    unhandled.stop();

    expect(outcome).toBe("returned");
    expect(unhandled.seen).toEqual([]);
  });

  it("with a statement in flight (a running execution's call): onDestroy returns", async () => {
    const unhandled = watchUnhandled();
    const connection = await connected();
    server.pause();
    await sleep(500);
    // the statement is never answered (pg leaves it pending once the pool ended): not awaited
    connection.ping().catch((): undefined => undefined);

    const outcome = await endsWithin(connection.onDestroy(), MARGIN_MS);
    server.unpause();
    await sleep(2000);
    unhandled.stop();

    expect(outcome).toBe("returned");
    expect(unhandled.seen).toEqual([]);
  });
});
