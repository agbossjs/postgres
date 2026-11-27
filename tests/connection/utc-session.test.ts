import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresConnection } from "../../src/index.js";
import { poolOptionsOf } from "../../src/connection/pool-options.js";
import { inSession, SET_UTC, sessionStatementsOf } from "../../src/connection/utc-session.js";

/**
 * Every session is in UTC and in the configured schema whatever the URL says (agbossjs/agboss#1307):
 * the URL's own `options` overrides the config's startup `options`, so the statements are sent on the
 * connection, awaited by the pool before it lends it. Built with no database.
 */
const pools: pg.Pool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.end();
});

/** A client that records what it is sent and fails the statements `failing` names. */
function recordingClient(failing = ""): {
  readonly client: pg.ClientBase;
  readonly sent: string[];
} {
  const sent: string[] = [];
  const query = (sql: string): Promise<object> => {
    sent.push(sql);
    return sql === failing ? Promise.reject(new Error(`refused ${sql}`)) : Promise.resolve({});
  };
  // a real client that never connects: its `query` is the recording one
  const client = new pg.Client();
  Reflect.set(client, "query", query);
  return { client, sent };
}

describe("the session of a connection", () => {
  it("is UTC, and the schema's search_path when one is configured, quoted", () => {
    expect(sessionStatementsOf(undefined)).toEqual([SET_UTC]);
    expect(sessionStatementsOf("app_a")).toEqual([SET_UTC, 'SET search_path TO "app_a"']);
  });

  it("is sent in order, and a statement that fails rejects (the pool then ends the connection)", async () => {
    const ok = recordingClient();
    await inSession(ok.client, "app_a");
    expect(ok.sent).toEqual([SET_UTC, 'SET search_path TO "app_a"']);

    const refused = recordingClient(SET_UTC);
    const hook = poolOptionsOf({ url: "postgres://h/d", schema: "app_a" }).onConnect;
    await expect(Promise.resolve(hook?.(refused.client))).rejects.toThrow("refused");
    expect(refused.sent).toEqual([SET_UTC]);
  });

  it("is what PostgresConnection's pool awaits on connect, whatever options the URL carries", async () => {
    const connection = new PostgresConnection({
      url: "postgres://u:p@localhost:1/d?options=-c%20timezone%3DAsia%2FJerusalem%20-c%20search_path%3Dpublic",
      schema: "app_b",
    });
    pools.push(connection.pool);
    const { client, sent } = recordingClient();

    const hook = poolOptionsOf({ url: "postgres://h/d", schema: "app_b" }).onConnect;
    await Promise.resolve(hook?.(client));

    expect(sent).toEqual([SET_UTC, 'SET search_path TO "app_b"']);
    expect(Reflect.get(connection.pool, "options")).toMatchObject({
      onConnect: expect.any(Function),
    });
  });
});
