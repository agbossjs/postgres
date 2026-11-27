import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresConnection } from "../../src/index.js";
import { SET_UTC, utcPoolOf } from "../../src/connection/utc-session.js";

/**
 * Every session is in UTC whatever the URL says (agbossjs/agboss#1307): the startup option can be
 * overridden by the URL's own `options`, so a connection is sent `SET TIME ZONE 'UTC'` when the pool
 * opens it. Built with no database: the pool's `connect` event is emitted by hand.
 */
const pools: pg.Pool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.end();
});

/** A client that records what it is sent. */
function recordingClient(): { readonly client: pg.PoolClient; readonly sent: string[] } {
  const sent: string[] = [];
  const query = (sql: string): Promise<object> => {
    sent.push(sql);
    return Promise.resolve({});
  };
  return { client: { query } as unknown as pg.PoolClient, sent };
}

describe("the UTC session", () => {
  it("a pool sends the statement to every connection it opens", () => {
    const pool = utcPoolOf(new pg.Pool());
    pools.push(pool);
    const first = recordingClient();
    const second = recordingClient();

    pool.emit("connect", first.client);
    pool.emit("connect", second.client);

    expect(first.sent).toEqual([SET_UTC]);
    expect(second.sent).toEqual([SET_UTC]);
  });

  it("a connection that refuses it rejects nothing unhandled", async () => {
    const pool = utcPoolOf(new pg.Pool());
    pools.push(pool);
    const client = { query: () => Promise.reject(new Error("gone")) } as unknown as pg.PoolClient;

    pool.emit("connect", client);
    await new Promise((resolve) => setImmediate(resolve));

    expect(pool.listenerCount("connect")).toBe(1);
  });

  it("PostgresConnection's pool is built with it, whatever options the URL carries", () => {
    const connection = new PostgresConnection({
      url: "postgres://u:p@localhost:1/d?options=-c%20timezone%3DAsia%2FJerusalem",
    });
    pools.push(connection.pool);
    const { client, sent } = recordingClient();

    connection.pool.emit("connect", client);

    expect(sent).toEqual([SET_UTC]);
  });
});
