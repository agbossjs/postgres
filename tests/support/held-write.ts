import pg from "pg";

/**
 * Seams of the lock tests (agbossjs/agboss#1302): a fenced write's work held open, and a wait on
 * the server's own lock graph — no timer decides that a statement waits.
 */

/** A fenced write's work held open, and the backend of its transaction. */
export interface HeldWrite {
  readonly entered: (client: pg.PoolClient | pg.Client) => Promise<void>;
  readonly released: Promise<void>;
  readonly release: () => void;
  readonly pid: Promise<number>;
}

/**
 * A fenced write's work held open: `entered` (called inside the work, on its client) records the
 * backend of the write's transaction (`pid`), `released` settles on `release()`.
 */
export function heldWrite(): HeldWrite {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let recordPid: (pid: number) => void = () => undefined;
  const pid = new Promise<number>((resolve) => {
    recordPid = resolve;
  });
  const entered = async (client: pg.PoolClient | pg.Client): Promise<void> => {
    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    recordPid(rows[0]?.pid ?? -1);
  };
  return { entered, released, release, pid };
}

/**
 * Settles `true` once a backend of the server at `url` waits for a lock `pid` holds
 * (`pg_blocking_pids`), `false` once `unless` settles first; polls the server, no timer.
 */
export async function blockedBy(
  url: string,
  pid: number,
  unless: Promise<unknown>,
): Promise<boolean> {
  const state = { isOver: false };
  const over = (): void => {
    state.isOver = true;
  };
  unless.then(over, over);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    while (!state.isOver) {
      const { rowCount } = await client.query(
        "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
        [pid],
      );
      if ((rowCount ?? 0) > 0) return true;
    }
    return false;
  } finally {
    await client.end();
  }
}
