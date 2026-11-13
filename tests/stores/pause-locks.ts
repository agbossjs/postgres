import pg from "pg";

/** A second session of a test: a transaction held open, and a look at who waits on a lock. */

/** A connection with a transaction begun: the caller ends it. */
export async function openTransaction(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("BEGIN");
  return client;
}

/** Whether a backend of the test's database waits for a lock. */
export async function isWaitingOnLock(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ waiting: string }>(
      `SELECT count(*) AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
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
export async function blockedBefore(url: string, work: Promise<unknown>): Promise<boolean> {
  const state = { isFinished: false };
  const finished = work.then(
    () => false,
    () => false,
  );
  void finished.then(() => {
    state.isFinished = true;
  });
  const probe = (async (): Promise<boolean> => {
    while (!state.isFinished) if (await isWaitingOnLock(url)) return true;
    return false;
  })();
  return Promise.race([probe, finished]);
}
