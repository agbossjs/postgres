/**
 * agbossjs/agboss#989: a connection that never answers its start fails the store call that needs
 * it, and its socket is closed. Two such peers: a server that takes the socket and says nothing (a
 * black-holed network, a proxy that drops the forward), and a socket connected to itself — what
 * hung a gate for 17 minutes: a client on `localhost:<port>` whose IPv6 attempt, nothing listening
 * on `::1`, was given that very port as its own source. Before, `pg` waited for the server's first
 * message forever. The bound is the test's own timeout: each call rejects, none hangs.
 */
import { createServer, Socket, type Server } from "node:net";
import { VirtualClock } from "@agboss/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONNECT_TIMEOUT, migratePostgres, PostgresConnection } from "../../src/index.js";
import { listenerOf } from "../../src/connection/postgres-connection.js";
import { inPoolTransaction } from "../../src/connection/transaction.js";

/** A server that accepts every connection and never writes a byte; each socket's close, awaitable. */
let silent: Server;
const closes: Promise<void>[] = [];
let silentPort = 0;

beforeAll(async () => {
  silent = createServer((socket) => {
    closes.push(
      new Promise((resolve) =>
        socket.once("close", () => {
          resolve();
        }),
      ),
    );
    // what the client sends is read and dropped, so its close reaches this end
    socket.resume();
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  silentPort = address.port;
});

afterAll(async () => {
  await new Promise((resolve) => silent.close(resolve));
});

/** A port free on `::1` now: nothing listens there once the probe is closed. */
async function freeIpv6Port(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "::1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** A socket that connects to itself: the port it is asked for taken as its own source too. */
class SelfConnecting extends Socket {
  constructor(private readonly port: number) {
    super();
  }

  override connect(): this {
    const { port } = this;
    return super.connect({ host: "::1", port, localAddress: "::1", localPort: port });
  }
}

describe("#989: a database that never answers the connection's start", () => {
  it("a statement, a transaction, a LISTEN and a migration each reject — none waits forever — and every socket is closed", async () => {
    // libpq's connect_timeout, in seconds: the bound a URL sets for itself
    const url = `postgres://app:secret@127.0.0.1:${String(silentPort)}/app?connect_timeout=1`;
    const connection = new PostgresConnection({ url, poolSize: 2 });
    const listening = {
      ...{ channel: "agboss_probe", payload: "probe", clock: new VirtualClock() },
      warn: () => undefined,
    };
    const outcomes = await Promise.allSettled([
      connection.ping(),
      inPoolTransaction(connection.pool, async (client) => client.query("SELECT 1")),
      listenerOf(connection, { ...listening, onNotify: () => undefined }),
      migratePostgres({ url }),
    ]);
    await connection.onDestroy();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(4).fill("rejected"));
    expect(closes).toHaveLength(4);
    // each socket the server took is closed by the client: none left open, half-started
    await Promise.all(closes);
  });

  it("a socket connected to itself: the store's call rejects with the connection timeout", async () => {
    const port = await freeIpv6Port();
    const url = `postgres://app:secret@localhost:${String(port)}/app?connect_timeout=1`;
    const connection = new PostgresConnection({ url, poolSize: 1 });
    connection.pool.options.stream = () => new SelfConnecting(port);

    await expect(connection.ping()).rejects.toThrow(/connection timeout/u);
    await connection.onDestroy();
  });

  it("without connect_timeout in the URL, the bound is DEFAULT_CONNECT_TIMEOUT (10 s)", async () => {
    const connection = new PostgresConnection({ url: "postgres://app@127.0.0.1:5432/app" });

    expect(DEFAULT_CONNECT_TIMEOUT).toBe(10_000);
    expect(connection.pool.options.connectionTimeoutMillis).toBe(DEFAULT_CONNECT_TIMEOUT);
    await connection.onDestroy();
  });
});
