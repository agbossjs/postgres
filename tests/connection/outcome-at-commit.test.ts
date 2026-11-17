/**
 * agbossjs/postgres#113 (agbossjs/agboss#1017's whitelist rule), on a real PostgreSQL through a TCP
 * proxy: a COMMIT, or a single write outside a transaction, whose connection is killed before the
 * server sees it, killed after the server applied it, or whose answer is replaced by a pooler's
 * protocol error (08P01) or by garbage, is `StoreOutcomeUnknownError` — and the database shows
 * which it was. The server's own abort (a deferred unique violation at COMMIT, a unique violation
 * of a single write) stays known. Red with the blacklist classifier: 08P01 and garbage were known.
 */
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "@agboss/core/stores";
import pg from "pg";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresConnection } from "../../src/index.js";
import { inPoolTransaction } from "../../src/connection/transaction.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import { onSchema, serverUrl, testDatabase } from "../support/database.js";
import { errorResponse } from "../support/pg-frames.js";

const database = testDatabase();
const opened: PostgresConnection[] = [];
const proxies: BlackholeProxy[] = [];

beforeAll(async () => {
  await onSchema(
    database.url(),
    `CREATE TABLE oc_rows (id int PRIMARY KEY);
     CREATE TABLE oc_once (id int, CONSTRAINT oc_once_id UNIQUE (id) DEFERRABLE INITIALLY DEFERRED)`,
  );
});

afterEach(async () => {
  for (const connection of opened.splice(0)) await connection.onDestroy();
  for (const proxy of proxies.splice(0)) await proxy.close();
});

/** A message of a type the protocol has none of: pg reads it as an error without a code. */
const GARBAGE = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x04]);

/** A connection of one client on the test schema through a proxy of its own. */
async function proxied(): Promise<{
  readonly connection: PostgresConnection;
  proxy: BlackholeProxy;
}> {
  const target = new URL(serverUrl());
  const proxy = await BlackholeProxy.start({
    host: target.hostname,
    port: Number(target.port === "" ? 5432 : target.port),
  });
  proxies.push(proxy);
  const url = new URL(database.url());
  url.port = String(proxy.port);
  const connection = new PostgresConnection({
    url: url.toString(),
    poolSize: 1,
    commandTimeout: 2000,
  });
  opened.push(connection);
  return { connection, proxy };
}

const settle = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

/** Whether the row `id` of `table` is in the database (read directly, not through the proxy). */
async function hasRow(table: string, id: number): Promise<boolean> {
  const client = new pg.Client({ connectionString: database.url() });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    return rows.length === 1;
  } finally {
    await client.end();
  }
}

/** A transaction inserting `id`, its COMMIT faulted by `arm`. */
async function committed(id: number, arm: (proxy: BlackholeProxy) => void): Promise<unknown> {
  const { connection, proxy } = await proxied();
  return settle(
    inPoolTransaction(connection.pool, async (client) => {
      await client.query("INSERT INTO oc_rows VALUES ($1)", [id]);
      arm(proxy);
    }),
  );
}

/** A single insert of `id` outside a transaction, faulted by `arm` on its text. */
async function written(
  id: number,
  arm: (proxy: BlackholeProxy, text: string) => void,
): Promise<unknown> {
  const { connection, proxy } = await proxied();
  const text = `INSERT INTO oc_rows VALUES (${String(id)})`;
  arm(proxy, text);
  return settle(connection.pool.query(text));
}

const expectUnknown = (error: unknown): void => {
  expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
  expect(error).toMatchObject({ source: StoreOutcomeSource.Transport });
};

describe("agbossjs/postgres#113: a COMMIT whose connection dies or whose answer is not the server's", () => {
  it("killed before the server sees it: unknown, and nothing was applied", async () => {
    const error = await committed(1, (proxy) => {
      proxy.withholdOn("COMMIT");
    });

    expectUnknown(error);
    expect(await hasRow("oc_rows", 1)).toBe(false);
  });

  it("killed after the server applied it: unknown, and the row is there", async () => {
    const error = await committed(2, (proxy) => {
      proxy.resetOn("COMMIT");
    });

    expectUnknown(error);
    expect(await hasRow("oc_rows", 2)).toBe(true);
  });

  it("applied, and a pooler answers 08P01 instead: unknown, and the row is there", async () => {
    const error = await committed(3, (proxy) => {
      proxy.answerOn("COMMIT", errorResponse("08P01", "server conn crashed?"));
    });

    expectUnknown(error);
    expect(error).toMatchObject({ cause: { code: "08P01" } });
    expect(await hasRow("oc_rows", 3)).toBe(true);
  });

  it("applied, and the answer is garbage: unknown, and the row is there", async () => {
    const error = await committed(4, (proxy) => {
      proxy.answerOn("COMMIT", GARBAGE);
    });

    expectUnknown(error);
    expect(await hasRow("oc_rows", 4)).toBe(true);
  });

  it("the server's own abort (a deferred unique violation): known, nothing applied", async () => {
    const { connection } = await proxied();

    const error = await settle(
      inPoolTransaction(connection.pool, (client) =>
        client.query("INSERT INTO oc_once VALUES (5), (5)"),
      ),
    );

    expect(error).not.toBeInstanceOf(StoreOutcomeUnknownError);
    expect(error).toMatchObject({ code: "23505" });
    expect(await hasRow("oc_once", 5)).toBe(false);
  });
});

describe("agbossjs/postgres#113: a single write outside a transaction, the same way", () => {
  it("killed before the server sees it: unknown, nothing applied", async () => {
    const error = await written(11, (proxy, text) => {
      proxy.withholdOn(text);
    });

    expectUnknown(error);
    expect(await hasRow("oc_rows", 11)).toBe(false);
  });

  it("killed after the server applied it: unknown, the row is there", async () => {
    const error = await written(12, (proxy, text) => {
      proxy.resetOn(text);
    });

    expectUnknown(error);
    expect(await hasRow("oc_rows", 12)).toBe(true);
  });

  it("applied, and a pooler answers 08P01 instead: unknown, the row is there", async () => {
    const error = await written(13, (proxy, text) => {
      proxy.answerOn(text, errorResponse("08P01", "server conn crashed?"));
    });

    expectUnknown(error);
    expect(await hasRow("oc_rows", 13)).toBe(true);
  });

  it("the server's own refusal (a unique violation): known", async () => {
    const { connection } = await proxied();
    await connection.pool.query("INSERT INTO oc_rows VALUES (14)");

    const error = await settle(connection.pool.query("INSERT INTO oc_rows VALUES (14)"));

    expect(error).not.toBeInstanceOf(StoreOutcomeUnknownError);
    expect(error).toMatchObject({ code: "23505" });
  });
});
