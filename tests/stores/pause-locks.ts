import pg from "pg";

/** A second session of a test: a transaction held open, and a look at who waits on a lock. */

/** A connection with a transaction begun: the caller ends it. */
export async function openTransaction(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("BEGIN");
  return client;
}

/** The server's pid of a session: what a waiter's `pg_blocking_pids` names when it waits for it. */
export async function pidOf(session: pg.Client): Promise<number> {
  const { rows } = await session.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return Number(rows[0]?.pid);
}

/** Whether a backend waits for a lock the session `holder` (its pid) holds — no other test's wait counts. */
export async function isWaitingOnLock(url: string, holder: number): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ waiting: string }>(
      `SELECT count(*) AS waiting FROM pg_stat_activity
       WHERE $1 = ANY(pg_blocking_pids(pid))`,
      [holder],
    );
    return Number(rows[0]?.waiting) > 0;
  } finally {
    await client.end();
  }
}

/**
 * Whether `work` waited for a lock before it finished: the probe asks the server until the work
 * ends or a backend waits — a blocked statement is seen as blocked, never timed out.
 */
export async function blockedBefore(
  url: string,
  holder: number,
  work: Promise<unknown>,
): Promise<boolean> {
  const state = { isFinished: false };
  const finished = work.then(
    () => false,
    () => false,
  );
  void finished.then(() => {
    state.isFinished = true;
  });
  const probe = (async (): Promise<boolean> => {
    while (!state.isFinished) if (await isWaitingOnLock(url, holder)) return true;
    return false;
  })();
  return Promise.race([probe, finished]);
}
