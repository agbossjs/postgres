import type pg from "pg";
import { isLostConnection } from "./outcome.js";

/**
 * `pool` whose promise `query` runs on a connection it checks out itself (agbossjs/agboss#928,
 * #1017). `pg.Pool.query` listens for the connection's `error` event and answers with that raw
 * error when the connection drops under a statement — before the `TimedClient` can read it as
 * `StoreOutcomeUnknownError`. Here the statement's own rejection is the answer. A connection that
 * is stuck or lost is not given back. Callbacks and submittables go to the pool as they are.
 */
export function timedPool(pool: pg.Pool): pg.Pool {
  const poolQuery = Reflect.get(pool, "query") as (...args: unknown[]) => unknown;
  const query = async (...args: unknown[]): Promise<unknown> => {
    const [first, second] = args;
    if (typeof first !== "string" || typeof second === "function" || args.length > 2)
      return Reflect.apply(poolQuery, pool, args);
    const client = await pool.connect();
    let isLost = false;
    // a checked-out connection that drops emits `error`: the statement in flight rejects with it
    const onLost = (): void => {
      isLost = true;
    };
    client.on("error", onLost);
    try {
      return await (second === undefined ? client.query(first) : client.query(first, second as []));
    } catch (error) {
      isLost ||= isLostConnection(error);
      throw error;
    } finally {
      client.off("error", onLost);
      client.release(isLost);
    }
  };
  Reflect.defineProperty(pool, "query", { value: query, configurable: true, writable: true });
  return pool;
}
