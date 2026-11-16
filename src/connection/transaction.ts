import type pg from "pg";
import { isLostConnection } from "./outcome.js";
import { LONG_COMMAND_TIMEOUT } from "./settings.js";
import { TimedClient } from "./timed-client.js";

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
    // a connection stuck on a statement or lost is not rolled back (a ROLLBACK would queue behind
    // the hung statement for another timeout) and not given back: the server rolls the transaction
    // back at the session's end (agbossjs/agboss#928). After the server's own cancel (57014) it
    // rolls back as usual.
    if (isLostConnection(error)) isBroken = true;
    else
      await client.query("ROLLBACK").catch(() => {
        // a connection whose rollback fails is not given back: the pool opens a new one
        isBroken = true;
      });
    throw error;
  } finally {
    client.off("error", onLost);
    client.release(isBroken);
  }
}

/**
 * `work` in one transaction whose statements may run for `LONG_COMMAND_TIMEOUT` (a retention's
 * `delete…Before`, agbossjs/agboss#928): the server's `statement_timeout` for the transaction, and
 * the client's `query_timeout` of each statement, a second later.
 */
export function inLongTransaction<TResult>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<TResult>,
): Promise<TResult> {
  return inPoolTransaction(pool, async (client) => {
    if (client instanceof TimedClient) client.useLongTimeout(LONG_COMMAND_TIMEOUT);
    await client.query(`SET LOCAL statement_timeout = ${String(LONG_COMMAND_TIMEOUT)}`);
    return work(client);
  });
}
