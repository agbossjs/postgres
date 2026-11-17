/**
 * The `TimedClient` and the timed pool beyond the command timeout's acceptance (agbossjs/agboss#928,
 * #1017): the forms of a statement each reaches the driver in, the transaction it tracks (a lost
 * answer is unknown only outside one), the long timeout of a retention's transaction, the socket of
 * a statement pg gave up on, and the pool's connections after a loss.
 */
import { StoreCallTimeoutError, StoreOutcomeUnknownError } from "@agboss/core/stores";
import pg from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresConnection } from "../../src/index.js";
import { TimedClient } from "../../src/connection/timed-client.js";
import { inLongTransaction, inPoolTransaction } from "../../src/connection/transaction.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import { onSchema, serverUrl, testDatabase } from "../support/database.js";

const database = testDatabase();
const opened: PostgresConnection[] = [];
const proxies: BlackholeProxy[] = [];
const pools: pg.Pool[] = [];

beforeAll(async () => {
  await onSchema(
    database.url(),
    `CREATE TABLE tc_rows (id int PRIMARY KEY, v int NOT NULL); INSERT INTO tc_rows VALUES (1, 0);
     CREATE TABLE tc_once (id int, CONSTRAINT tc_once_id UNIQUE (id) DEFERRABLE INITIALLY DEFERRED)`,
  );
});

afterEach(async () => {
  for (const connection of opened.splice(0)) await connection.onDestroy();
  for (const pool of pools.splice(0)) await pool.end();
  for (const proxy of proxies.splice(0)) await proxy.close();
});

/** A connection of one client on the test schema, a 300 ms command timeout; through `url` if given. */
function connected(url = database.url(), poolSize = 1): PostgresConnection {
  const connection = new PostgresConnection({ url, poolSize, commandTimeout: 300 });
  opened.push(connection);
  return connection;
}

/** The test schema's URL through a proxy that can drop or reset its connections. */
async function proxied(): Promise<{ readonly url: string; readonly proxy: BlackholeProxy }> {
  const target = new URL(serverUrl());
  const proxy = await BlackholeProxy.start({
    host: target.hostname,
    port: Number(target.port === "" ? 5432 : target.port),
  });
  proxies.push(proxy);
  const url = new URL(database.url());
  url.port = String(proxy.port);
  return { url: url.toString(), proxy };
}

const settle = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

/** The pool's client, a `TimedClient` (released by the caller). */
async function timedClientOf(connection: PostgresConnection): Promise<TimedClient & pg.PoolClient> {
  const client = await connection.pool.connect();
  if (!(client instanceof TimedClient)) throw new Error("the pool's client is no TimedClient");
  return client;
}

/** `client.query` with arguments no overload of its type takes. */
const queryWith = (client: pg.ClientBase | pg.Pool, ...args: unknown[]): unknown =>
  Reflect.apply(Reflect.get(client, "query") as (...given: unknown[]) => unknown, client, args);

/** A callback-form call's answer. */
const answerOf = (call: (callback: (error: unknown, result?: unknown) => void) => void) =>
  new Promise<{ readonly error: unknown; readonly result: unknown }>((resolve) => {
    call((error, result) => {
      resolve({ error, result });
    });
  });

describe("the forms of a statement", () => {
  it("the callback forms answer through the callback: text, text and values, an error", async () => {
    const connection = connected();
    const client = await timedClientOf(connection);
    try {
      const plain = await answerOf((callback) => queryWith(client, "SELECT 1 AS one", callback));
      const valued = await answerOf((callback) =>
        queryWith(client, "SELECT $1::int AS n", [5], callback),
      );
      const failed = await answerOf((callback) => queryWith(client, "SELECT nope", callback));

      expect(plain).toMatchObject({ error: null, result: { rows: [{ one: 1 }] } });
      expect(valued).toMatchObject({ error: null, result: { rows: [{ n: 5 }] } });
      expect(failed.error).toMatchObject({ code: "42703" });
    } finally {
      client.release();
    }
  });

  it("the pool's callback forms are pg.Pool's: text, text and values", async () => {
    const { pool } = connected();

    const plain = await answerOf((callback) => queryWith(pool, "SELECT 2 AS two", callback));
    const valued = await answerOf((callback) =>
      queryWith(pool, "SELECT $1::int AS n", [6], callback),
    );

    expect(plain).toMatchObject({ result: { rows: [{ two: 2 }] } });
    expect(plain.error).toBeUndefined();
    expect(valued).toMatchObject({ result: { rows: [{ n: 6 }] } });
    expect(valued.error).toBeUndefined();
  });

  it("a query config is timed as its text is: past the command timeout, StoreCallTimeoutError", async () => {
    const connection = connected();
    const client = await timedClientOf(connection);
    const own = await settle(client.query({ text: "SELECT pg_sleep(1)" }));
    client.release();
    const pooled = await settle(connection.pool.query({ text: "SELECT pg_sleep(1)" }));

    expect(own).toBeInstanceOf(StoreCallTimeoutError);
    expect(own).toMatchObject({ operation: "SELECT pg_sleep(1)" });
    expect(pooled).toBeInstanceOf(StoreCallTimeoutError);
    await expect(
      connection.pool.query({ text: "SELECT $1::int AS n", values: [7] }),
    ).resolves.toMatchObject({ rows: [{ n: 7 }] });
  });

  it("a submittable is the driver's: it comes back as it was given, and runs", async () => {
    const connection = connected();
    const client = await timedClientOf(connection);
    try {
      const submittable = new pg.Query("SELECT 8 AS eight");
      const ended = new Promise<unknown>((resolve) => {
        submittable.on("row", resolve);
      });

      expect(queryWith(client, submittable)).toBe(submittable);
      expect(await ended).toEqual({ eight: 8 });
    } finally {
      client.release();
    }
  });

  it("what is no statement is the driver's to refuse: null, undefined", async () => {
    const connection = connected();
    const client = await timedClientOf(connection);
    try {
      expect(() => queryWith(client, null)).toThrow("Client was passed a null or undefined query");
      expect(() => queryWith(client, undefined)).toThrow(
        "Client was passed a null or undefined query",
      );
    } finally {
      client.release();
    }
  });

  it("the client's and the pool's query stay replaceable as a method is: a spy, a wrapper", async () => {
    const connection = connected();
    const client = await timedClientOf(connection);
    const onClient = vi.spyOn(client, "query");
    await client.query("SELECT 1");
    const clientCalls = onClient.mock.calls.length;
    onClient.mockRestore();
    client.release();
    const onPool = vi.spyOn(connection.pool, "query");
    await connection.pool.query("SELECT 1");
    const poolCalls = onPool.mock.calls.length;
    onPool.mockRestore();
    const { pool } = connection;
    // assigned, as a wrapper does; redefined, as a spy may
    const again = await timedClientOf(connection);
    const boundClient = again.query.bind(again);
    again.query = boundClient;
    Object.defineProperty(again, "query", { value: boundClient, writable: true });
    await again.query("SELECT 1");
    // and removed, as a spy's restore does
    expect(Reflect.deleteProperty(again, "query")).toBe(true);
    again.release();
    const boundPool = pool.query.bind(pool);
    pool.query = boundPool;
    Object.defineProperty(pool, "query", { value: boundPool, writable: true });
    const answered = await pool.query("SELECT 3 AS three");
    expect(Reflect.deleteProperty(pool, "query")).toBe(true);

    expect({ clientCalls, poolCalls }).toEqual({ clientCalls: 1, poolCalls: 1 });
    expect(answered).toMatchObject({ rows: [{ three: 3 }] });
  });
});

describe("the transaction it tracks: a lost answer is unknown only outside one", () => {
  /** A single write whose answer the proxy drops, on `connection`'s one client. */
  async function lostWrite(
    connection: PostgresConnection,
    proxy: BlackholeProxy,
    value: number,
  ): Promise<unknown> {
    proxy.resetOn(`SET v = ${String(value)}`);
    return settle(connection.pool.query(`UPDATE tc_rows SET v = ${String(value)} WHERE id = 1`));
  }

  it("after a COMMIT the session is out of the transaction", async () => {
    const { url, proxy } = await proxied();
    const connection = connected(url);
    await inPoolTransaction(connection.pool, (client) => client.query("SELECT 1"));

    expect(await lostWrite(connection, proxy, 11)).toBeInstanceOf(StoreOutcomeUnknownError);
  });

  it("after a COMMIT that failed the session is out of the transaction too", async () => {
    const { url, proxy } = await proxied();
    const connection = connected(url);
    const client = await timedClientOf(connection);
    await client.query("BEGIN");
    await client.query("INSERT INTO tc_once VALUES (1), (1)");
    const commit = await settle(client.query("COMMIT"));
    client.release();

    expect(commit).toMatchObject({ code: "23505" });
    expect(await lostWrite(connection, proxy, 12)).toBeInstanceOf(StoreOutcomeUnknownError);
  });

  it("a statement that only names begin does not start one", async () => {
    const { url, proxy } = await proxied();
    const connection = connected(url);
    await connection.pool.query("SELECT'begin' AS word");

    expect(await lostWrite(connection, proxy, 13)).toBeInstanceOf(StoreOutcomeUnknownError);
  });

  it("a statement that fails inside one does not end it: the transaction is aborted, not over", async () => {
    const { url, proxy } = await proxied();
    const connection = connected(url);
    const client = await timedClientOf(connection);
    try {
      await client.query("BEGIN");
      const failed = await settle(client.query("SELECT nope"));
      proxy.resetOn("SET v = 17");
      const lost = await settle(client.query("UPDATE tc_rows SET v = 17 WHERE id = 1"));

      expect(failed).toMatchObject({ code: "42703" });
      expect(lost).toBeInstanceOf(Error);
      expect(lost).not.toBeInstanceOf(StoreOutcomeUnknownError);
    } finally {
      client.release(true);
    }
  });

  it("a statement inside one that only names rollback does not end it", async () => {
    const { url, proxy } = await proxied();
    const connection = connected(url);
    proxy.resetOn("SET v = 14");

    const failure = await settle(
      inPoolTransaction(connection.pool, async (client) => {
        await client.query("SELECT'rollback' AS word");
        return client.query("UPDATE tc_rows SET v = 14 WHERE id = 1");
      }),
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(StoreOutcomeUnknownError);
  });
});

describe("the long timeout of a transaction (a retention's delete)", () => {
  it("its statements run past the command timeout and its margin; past the long one the server cancels; after it, the command timeout again", async () => {
    const connection = connected();
    const client = await timedClientOf(connection);
    try {
      await client.query("BEGIN");
      client.useLongTimeout(2000);
      await client.query("SET LOCAL statement_timeout = 2000");
      // 1.4 s: past the command timeout (300 ms) and pg's own limit a second later
      await expect(client.query("SELECT pg_sleep(1.4)")).resolves.toBeDefined();
      await expect(client.query({ text: "SELECT pg_sleep($1)" }, [1.4])).resolves.toBeDefined();
      const cancelled = await settle(client.query("SELECT pg_sleep(3)"));
      await client.query("ROLLBACK");
      const after = await settle(client.query("SELECT pg_sleep(1)"));

      expect(cancelled).toBeInstanceOf(StoreCallTimeoutError);
      expect(cancelled).toMatchObject({ timeout: 2000, cause: { code: "57014" } });
      expect(after).toMatchObject({ timeout: 300, cause: { code: "57014" } });
    } finally {
      client.release();
    }
  });

  it("inLongTransaction on a plain pg pool sets the server's statement_timeout alone", async () => {
    const pool = new pg.Pool({ connectionString: database.url(), max: 1 });
    pools.push(pool);

    const inside = await inLongTransaction(pool, (client) =>
      client.query("SHOW statement_timeout"),
    );

    expect(inside.rows).toEqual([{ statement_timeout: "5min" }]);
  });
});

describe("a connection lost or stuck", () => {
  it("after pg's client-side timeout the client takes no more statements: the next one is refused, never queued", async () => {
    const { url, proxy } = await proxied();
    const connection = connected(url);
    const client = await timedClientOf(connection);
    try {
      proxy.cut();
      const stuck = await settle(client.query("SELECT 1"));
      const next = await settle(client.query("SELECT 2"));

      expect(stuck).toBeInstanceOf(StoreCallTimeoutError);
      expect(next).toBeInstanceOf(Error);
      expect(next).not.toBeInstanceOf(StoreCallTimeoutError);
    } finally {
      client.release(true);
    }
  });

  it.each([
    ["a single statement", (pool: pg.Pool) => pool.query("SELECT 1")],
    [
      "a transaction",
      (pool: pg.Pool) => inPoolTransaction(pool, (client) => client.query("SELECT 1")),
    ],
  ] as const)(
    "%s whose connection is stuck: a caller waiting for the pool gets a new one",
    async (_, stuckCall) => {
      const { url, proxy } = await proxied();
      const connection = connected(url);
      await connection.ping();
      proxy.cut();

      const stuck = settle(stuckCall(connection.pool));
      const waiting = connection.pool.query("SELECT 4 AS four");

      expect(await stuck).toBeInstanceOf(StoreCallTimeoutError);
      await expect(waiting).resolves.toMatchObject({ rows: [{ four: 4 }] });
    },
  );

  it("a connection dropped under a pool statement or a transaction rejects it; nothing is thrown outside; the client goes back as it was", async () => {
    const { url, proxy } = await proxied();
    const connection = connected(url);
    const client = await timedClientOf(connection);
    const listeners = client.listenerCount("error");
    client.release();
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    try {
      await connection.pool.query("SELECT 1");
      await inPoolTransaction(connection.pool, (one) => one.query("SELECT 1"));
      const again = await timedClientOf(connection);
      const count = again.listenerCount("error");
      again.release();
      proxy.resetOn("SET v = 15");
      const single = await settle(connection.pool.query("UPDATE tc_rows SET v = 15 WHERE id = 1"));
      proxy.resetOn("SET v = 16");
      const inside = await settle(
        inPoolTransaction(connection.pool, (one) =>
          one.query("UPDATE tc_rows SET v = 16 WHERE id = 1"),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(again).toBe(client);
      expect(count).toBe(listeners);
      expect(single).toBeInstanceOf(StoreOutcomeUnknownError);
      expect(inside).toBeInstanceOf(Error);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("a transaction whose work fails is rolled back on its connection, which serves again outside any transaction", async () => {
    const connection = connected();

    const failure = await settle(
      inPoolTransaction(connection.pool, async (client) => {
        await client.query("UPDATE tc_rows SET v = 99 WHERE id = 1");
        throw new Error("the work failed");
      }),
    );
    const { rows } = await connection.pool.query(
      "SELECT v, now() = statement_timestamp() AS fresh FROM tc_rows WHERE id = 1",
    );

    expect(failure).toMatchObject({ message: "the work failed" });
    expect(rows).toEqual([{ v: expect.any(Number) as number, fresh: true }]);
    expect(rows[0]).not.toMatchObject({ v: 99 });
  });
});
