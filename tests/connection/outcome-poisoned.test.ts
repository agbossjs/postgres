/**
 * agbossjs/postgres#113, the spec review's J.1 B.2: a connection whose COMMIT ended with its outcome
 * unknown is past trust. It is never handed out by the pool again, and every later statement on it
 * (LangGraph's `PostgresSaver` rolls back in its own `catch`) rejects with that same unknown outcome,
 * not with an error that hides it. And `pool.query` with a query config is read as the string form is.
 */
import type pg from "pg";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresConnection } from "../../src/index.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import { onSchema, serverUrl, testDatabase } from "../support/database.js";
import { errorResponse, READY_FOR_QUERY_IDLE } from "../support/pg-frames.js";
import { StoreError } from "@agboss/core/stores";

const database = testDatabase();
const opened: PostgresConnection[] = [];
const proxies: BlackholeProxy[] = [];

beforeAll(async () => {
  await onSchema(database.url(), "CREATE TABLE op_rows (id int PRIMARY KEY)");
});

afterEach(async () => {
  for (const connection of opened.splice(0)) await connection.onDestroy();
  for (const proxy of proxies.splice(0)) await proxy.close();
});

/** A connection of one client on the test schema through a proxy of its own. */
async function proxied(): Promise<{ readonly pool: pg.Pool; readonly proxy: BlackholeProxy }> {
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
  return { pool: connection.pool, proxy };
}

const settle = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

/**
 * `PostgresSaver`'s own transaction (`@langchain/langgraph-checkpoint-postgres`, `put`): BEGIN, the
 * write, COMMIT; on a failure ROLLBACK and rethrow what the ROLLBACK threw; release in `finally`.
 * Answers the error it rejects with, and the client it ran on.
 */
async function saverLike(pool: pg.Pool, id: number): Promise<{ error: unknown; client: unknown }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO op_rows VALUES ($1)", [id]);
    await client.query("COMMIT");
    return { error: undefined, client };
  } catch (error) {
    const rolledBack = await settle(client.query("ROLLBACK"));
    return { error: rolledBack ?? error, client };
  } finally {
    client.release();
  }
}

describe("agbossjs/postgres#113: a connection of unknown outcome is past trust", () => {
  it("a pooler answers 08P01 for the COMMIT and keeps the link: the ROLLBACK rejects with that unknown outcome, the pool never hands the client out again", async () => {
    const { pool, proxy } = await proxied();
    const answer = Buffer.concat([
      errorResponse("08P01", "server conn crashed?", "ERROR"),
      READY_FOR_QUERY_IDLE,
    ]);
    proxy.answerOn("COMMIT", answer, { keepsOpen: true });

    const { error, client } = await saverLike(pool, 1);
    const next = await pool.connect();
    next.release();

    expect(error).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(error).toMatchObject({ cause: { code: "08P01" } });
    expect(next).not.toBe(client);
  });

  it("the link reset after the COMMIT applied: the ROLLBACK rejects with the unknown outcome, not with 'not queryable'", async () => {
    const { pool, proxy } = await proxied();
    proxy.resetOn("COMMIT");

    const { error, client } = await saverLike(pool, 2);
    const next = await pool.connect();
    next.release();

    expect(error).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(next).not.toBe(client);
  });

  it("pool.query with a query config whose answer is lost: unknown, as the string form", async () => {
    const { pool, proxy } = await proxied();
    proxy.resetOn("VALUES ($1)");

    const error = await settle(
      pool.query({ text: "INSERT INTO op_rows VALUES ($1)", values: [3] }),
    );

    expect(error).toBeInstanceOf(StoreError.OutcomeUnknown);
  });
});
