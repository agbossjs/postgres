/**
 * agbossjs/agboss#928 (postgres#96): every statement of the pool is bounded, a command that does
 * not answer is `StoreError.CallTimeout` (source Command), a connection lost under a COMMIT or a
 * single write is `StoreError.OutcomeUnknown` (source Transport, agbossjs/agboss#1017), and a session
 * idle in a transaction is ended by the server so a frozen holder's row locks are freed.
 */
import { StoreOutcomeSource, StoreError, isStoreOutcomeUnknown } from "@agboss/core/stores";
import pg from "pg";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresConnection, PostgresMeshRequestRepository } from "../../src/index.js";
import { inLongTransaction, inPoolTransaction } from "../../src/connection/transaction.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import { onSchema, serverUrl, testDatabase } from "../support/database.js";

const database = testDatabase();
const opened: PostgresConnection[] = [];
const holders: pg.Client[] = [];
const proxies: BlackholeProxy[] = [];

beforeAll(async () => {
  await onSchema(
    database.url(),
    "CREATE TABLE ct_rows (id int PRIMARY KEY, v int NOT NULL); INSERT INTO ct_rows VALUES (1, 0)",
  );
});

afterEach(async () => {
  for (const holder of holders.splice(0)) await holder.end().catch(() => undefined);
  for (const connection of opened.splice(0)) await connection.onDestroy();
  for (const proxy of proxies.splice(0)) await proxy.close();
});

/** A connection on the test schema with a 300 ms command timeout (the range's floor is 100 ms). */
function connected(
  settings: { url?: string; idleInTransactionTimeout?: number; poolSize?: number } = {},
): PostgresConnection {
  const connection = new PostgresConnection({
    url: database.url(),
    poolSize: 1,
    commandTimeout: 300,
    ...settings,
  });
  opened.push(connection);
  return connection;
}

/** A session of its own on the test schema (ended after the test). */
async function session(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: database.url() });
  await client.connect();
  holders.push(client);
  return client;
}

/** The URL of the test schema through a proxy of the database. */
async function proxied(): Promise<{ readonly url: string; readonly proxy: BlackholeProxy }> {
  const target = new URL(serverUrl());
  const proxy = await BlackholeProxy.start({
    host: target.hostname,
    port: Number(target.port === "" ? 5432 : target.port),
  });
  proxies.push(proxy);
  const url = new URL(database.url());
  url.hostname = "127.0.0.1";
  url.port = String(proxy.port);
  return { url: url.toString(), proxy };
}

const valueOf = async (): Promise<number> => {
  const { rows } = await onSchema(database.url(), "SELECT v FROM ct_rows WHERE id = 1");
  return (rows[0] as { v: number }).v;
};

const settle = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("AC1: a statement that does not answer in the command timeout", () => {
  it("a write waiting on a row lock is cancelled by the server: StoreError.CallTimeout (command), cause 57014, and the connection serves again", async () => {
    const connection = connected();
    const holder = await session();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM ct_rows WHERE id = 1 FOR UPDATE");

    const failure = await settle(connection.pool.query("UPDATE ct_rows SET v = 5 WHERE id = 1"));
    await holder.query("ROLLBACK");

    expect(failure).toBeInstanceOf(StoreError.CallTimeout);
    expect(failure).toMatchObject({
      code: "store.call-timeout",
      source: StoreOutcomeSource.Command,
      store: "PostgresConnection",
      timeout: 300,
      cause: { code: "57014" },
    });
    expect((await connection.pool.query("SELECT v FROM ct_rows WHERE id = 1")).rows).toEqual([
      { v: 0 },
    ]);
    expect(connection.pool.totalCount).toBe(1);
  });

  it("inside a transaction the server's cancel rolls it back as usual and the connection is kept", async () => {
    const connection = connected();
    const holder = await session();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM ct_rows WHERE id = 1 FOR UPDATE");

    const failure = await settle(
      inPoolTransaction(connection.pool, (client) =>
        client.query("UPDATE ct_rows SET v = 6 WHERE id = 1"),
      ),
    );
    await holder.query("ROLLBACK");

    expect(failure).toBeInstanceOf(StoreError.CallTimeout);
    expect(connection.pool.totalCount).toBe(1);
    expect(await valueOf()).toBe(0);
  });

  it("a silent server: pg's client-side timeout is StoreError.CallTimeout, the socket is destroyed, nothing is rolled back behind it, the pool serves again", async () => {
    const { url, proxy } = await proxied();
    const connection = connected({ url });
    await connection.ping();
    proxy.cut();

    const failure = await settle(
      inPoolTransaction(connection.pool, (client) => client.query("SELECT 1")),
    );

    expect(failure).toBeInstanceOf(StoreError.CallTimeout);
    expect(failure).toMatchObject({ source: StoreOutcomeSource.Command, timeout: 300 });
    expect((failure as Error).cause).toMatchObject({ message: "Query read timeout" });
    expect(connection.pool.totalCount).toBe(0);
    await expect(connection.pool.query("SELECT 1 AS one")).resolves.toMatchObject({
      rows: [{ one: 1 }],
    });
  });
});

describe("agbossjs/agboss#1017: an answer lost in transport", () => {
  it("a COMMIT whose answer is lost is StoreError.OutcomeUnknown (transport), and the commit is in the database", async () => {
    const { url, proxy } = await proxied();
    const connection = connected({ url });
    await connection.ping();
    proxy.resetOn("COMMIT");

    const failure = await settle(
      inPoolTransaction(connection.pool, (client) =>
        client.query("UPDATE ct_rows SET v = 7 WHERE id = 1"),
      ),
    );

    expect(failure).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(failure).not.toBeInstanceOf(StoreError.CallTimeout);
    expect(failure).toMatchObject({ source: StoreOutcomeSource.Transport });
    expect(await valueOf()).toBe(7);
  });

  it("a single write whose answer is lost is unknown; the write is in the database", async () => {
    const { url, proxy } = await proxied();
    const connection = connected({ url });
    await connection.ping();
    proxy.resetOn("SET v = 8");

    const failure = await settle(connection.pool.query("UPDATE ct_rows SET v = 8 WHERE id = 1"));

    expect(failure).toMatchObject({ source: StoreOutcomeSource.Transport });
    expect(await valueOf()).toBe(8);
  });

  it("a statement inside a transaction, before its COMMIT, is an ordinary error: the session died, the transaction rolled back", async () => {
    const { url, proxy } = await proxied();
    const connection = connected({ url });
    await connection.ping();
    proxy.resetOn("SET v = 9");

    const failure = await settle(
      inPoolTransaction(connection.pool, (client) =>
        client.query("UPDATE ct_rows SET v = 9 WHERE id = 1"),
      ),
    );

    expect(failure).toBeInstanceOf(Error);
    expect(isStoreOutcomeUnknown(failure)).toBe(false);
    expect(await valueOf()).toBe(8);
  });

  it("a read whose answer is lost is an ordinary error: a read has no effect", async () => {
    const { url, proxy } = await proxied();
    const connection = connected({ url });
    await connection.ping();
    proxy.resetOn("SELECT v FROM ct_rows");

    const failure = await settle(connection.pool.query("SELECT v FROM ct_rows WHERE id = 1"));

    expect(failure).toBeInstanceOf(Error);
    expect(isStoreOutcomeUnknown(failure)).toBe(false);
  });
});

describe("a session idle in a transaction", () => {
  it("is ended by the server after idleInTransactionTimeout: its row lock is freed for the next session, and its next statement fails", async () => {
    const connection = connected({ idleInTransactionTimeout: 200 });
    const other = await session();
    let isLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      isLocked = resolve;
    });

    const frozen = settle(
      inPoolTransaction(connection.pool, async (client) => {
        await client.query("SELECT 1 FROM ct_rows WHERE id = 1 FOR UPDATE");
        isLocked();
        // the holder goes silent inside the transaction (a SIGSTOP, a hung work)
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return client.query("SELECT 1");
      }),
    );
    await locked;
    // waits on the holder's lock until the server ends the holder's session
    await other.query("SELECT 1 FROM ct_rows WHERE id = 1 FOR UPDATE");

    const failure = await frozen;
    // inside a transaction before its COMMIT: a known outcome, rolled back with the session
    expect(failure).toBeInstanceOf(Error);
    expect(isStoreOutcomeUnknown(failure)).toBe(false);
  });
});

describe("a retention's delete runs under the long timeout", () => {
  it("inLongTransaction: statement_timeout is 5 min inside, the command timeout again after", async () => {
    const connection = connected();

    const inside = await inLongTransaction(connection.pool, (client) =>
      client.query("SHOW statement_timeout"),
    );
    const after = await connection.pool.query("SHOW statement_timeout");

    expect(inside.rows).toEqual([{ statement_timeout: "5min" }]);
    expect(after.rows).toEqual([{ statement_timeout: "300ms" }]);
  });

  it("deleteByCreatedAtBefore waits out a lock longer than the command timeout; an ordinary write does not", async () => {
    const connection = connected({ poolSize: 2 });
    const holder = await session();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE agboss_mesh_requests IN ACCESS EXCLUSIVE MODE");
    const retention = new PostgresMeshRequestRepository(connection);

    const deleting = retention.deleteExpired(new Date());
    const ordinary = await settle(connection.pool.query("DELETE FROM agboss_mesh_requests"));
    // past the command timeout and pg's own limit a second after it: only the long timeout waits
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await holder.query("ROLLBACK");

    expect(ordinary).toBeInstanceOf(StoreError.CallTimeout);
    // how many went: nothing was in the table
    await expect(deleting).resolves.toBe(0);
  });
});
