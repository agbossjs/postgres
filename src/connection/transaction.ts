import type pg from "pg";

/**
 * Transactions of the PostgreSQL stores: `BEGIN` (`READ COMMITTED`, PostgreSQL's default) → the
 * work → `COMMIT`, rolled back when the work throws. A failed rollback (the connection lost) ends
 * that connection instead of returning it to the pool; the work's own error is what rejects.
 */

/** `work` in one transaction on `client` (a migration's session). */
export async function inTransaction<TResult>(
  client: pg.ClientBase,
  work: () => Promise<TResult>,
): Promise<TResult> {
  await client.query("BEGIN");
  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * `work` with one connection of the pool, in one transaction: every statement of the work runs on
 * that connection (`work(client)`), so it holds no second one — a pool of one never deadlocks.
 */
export async function inPoolTransaction<TResult>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await pool.connect();
  let isBroken = false;
  // a checked-out connection that drops emits `error` (the pool listens on idle ones only): the
  // statement in flight rejects with it, the connection is not given back
  const onLost = (): void => {
    isBroken = true;
  };
  client.on("error", onLost);
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // a connection whose rollback fails is not given back: the pool opens a new one
    await client.query("ROLLBACK").catch(() => {
      isBroken = true;
    });
    throw error;
  } finally {
    client.off("error", onLost);
    client.release(isBroken);
  }
}
