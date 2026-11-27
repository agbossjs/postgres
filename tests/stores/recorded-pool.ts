import pg from "pg";
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
  const sent: Sent[] = [];
  const queue = [...answers];
  const query = (sql: string, values: readonly unknown[] = []) => {
    sent.push({ sql, values });
    const rows = CONTROL.test(sql) ? [] : (queue.shift() ?? []);
    return Promise.resolve({ rows, rowCount: rows.length });
  };
  const pool = new pg.Pool();
  Reflect.set(pool, "query", query);
  Reflect.set(pool, "connect", () =>
    Promise.resolve({ query, on: () => undefined, off: () => undefined, release: () => undefined }),
  );
  pools.push(pool);
  return { pool, sent };
}

export const squeezed = (sql: string): string => sql.replace(/\s+/gu, " ");
