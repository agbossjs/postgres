import pg from "pg";
import { PostgresConnection } from "../../src/index.js";
import { afterEach } from "vitest";

/** One statement a recorded pool was sent, with its parameters. */
export interface Sent {
  readonly sql: string;
  readonly values: readonly unknown[];
}

const pools: pg.Pool[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.end();
});

const CONTROL = /^(BEGIN|COMMIT|ROLLBACK)$/u;

/**
 * A pool that never connects and answers `answers` in turn (empty rows after), its pool-level
 * `query` and the `query` of every connection it lends recording what was sent. The transaction's
 * own `BEGIN`, `COMMIT` and `ROLLBACK` are recorded and answered empty, never taking an answer.
 */
export function recordedPool(answers: readonly (readonly object[])[] = []): {
  readonly pool: pg.Pool;
  readonly sent: Sent[];
} {
  const pool = new pg.Pool();
  pools.push(pool);
  return { pool, sent: recordingOn(pool, answers) };
}

/** What a scripted statement answers: its rows (none: an empty answer). */
export type Respond = (sql: string, values: readonly unknown[]) => readonly object[] | undefined;

/**
 * A pool that answers each statement by what `respond` says of its text and parameters (empty when
 * it says nothing), recording what was sent: for a transaction whose statements are not in a fixed
 * order. As `recordedPool`, `BEGIN`, `COMMIT` and `ROLLBACK` are answered empty.
 */
export function scriptedPool(respond: Respond): { readonly pool: pg.Pool; readonly sent: Sent[] } {
  const pool = new pg.Pool();
  pools.push(pool);
  return { pool, sent: scriptOn(pool, respond) };
}

/** A `PostgresConnection` whose pool answers as `scriptedPool`'s does. */
export function scriptedConnection(respond: Respond): {
  readonly connection: PostgresConnection;
  readonly sent: Sent[];
} {
  const connection = new PostgresConnection({ url: "postgres://u:p@127.0.0.1:1/d" });
  pools.push(connection.pool);
  return { connection, sent: scriptOn(connection.pool, respond) };
}

function scriptOn(pool: pg.Pool, respond: Respond): Sent[] {
  const sent: Sent[] = [];
  const query = (sql: string, values: readonly unknown[] = []) => {
    sent.push({ sql, values });
    const rows = CONTROL.test(sql) ? [] : (respond(sql, values) ?? []);
    return Promise.resolve({ rows, rowCount: rows.length });
  };
  Reflect.set(pool, "query", query);
  Reflect.set(pool, "connect", () =>
    Promise.resolve({ query, on: () => undefined, off: () => undefined, release: () => undefined }),
  );
  return sent;
}

/** A `PostgresConnection` whose pool is a recorded one (nothing connects). */
export function recordedConnection(answers: readonly (readonly object[])[] = []): {
  readonly connection: PostgresConnection;
  readonly sent: Sent[];
} {
  const connection = new PostgresConnection({ url: "postgres://u:p@127.0.0.1:1/d" });
  pools.push(connection.pool);
  return { connection, sent: recordingOn(connection.pool, answers) };
}

/** Makes `pool` record and answer as `recordedPool` does; what it was sent. */
function recordingOn(pool: pg.Pool, answers: readonly (readonly object[])[]): Sent[] {
  const sent: Sent[] = [];
  const queue = [...answers];
  const query = (sql: string, values: readonly unknown[] = []) => {
    sent.push({ sql, values });
    const rows = CONTROL.test(sql) ? [] : (queue.shift() ?? []);
    return Promise.resolve({ rows, rowCount: rows.length });
  };
  Reflect.set(pool, "query", query);
  Reflect.set(pool, "connect", () =>
    Promise.resolve({ query, on: () => undefined, off: () => undefined, release: () => undefined }),
  );
  return sent;
}

export const squeezed = (sql: string): string => sql.replace(/\s+/gu, " ");
