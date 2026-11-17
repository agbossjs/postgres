import type pg from "pg";
import { isLostConnection } from "./outcome.js";

/** A statement's text or its query config (`{ text, values }`); not a submittable (its errors are events). */
const isStatement = (value: unknown): boolean =>
  typeof value === "string" ||
  (typeof value === "object" && value !== null && "text" in value && !("submit" in value));

/**
 * `pool` whose promise `query` runs on a connection it checks out itself (agbossjs/agboss#928,
 * #1017). `pg.Pool.query` listens for the connection's `error` event and answers with that raw
 * error when the connection drops under a statement — before the `TimedClient` can read it as
 * `StoreOutcomeUnknownError`. Here the statement's own rejection is the answer. A connection that
 * is stuck or lost is not given back. A query config (`{ text, values }`) is read as the text is
 * (postgres#113); callbacks and submittables go to the pool as they are.
 */
export function timedPool(pool: pg.Pool): pg.Pool {
  const poolQuery = Reflect.get(pool, "query") as (...args: unknown[]) => unknown;
  const query = async (...args: unknown[]): Promise<unknown> => {
    const [first] = args;
    if (!isStatement(first) || args.length > 2 || args.some((arg) => typeof arg === "function"))
      return Reflect.apply(poolQuery, pool, args);
    const client = await pool.connect();
    let isLost = false;
    // a checked-out connection that drops emits `error`: the statement in flight rejects with it
    const onLost = (): void => {
      isLost = true;
    };
    client.on("error", onLost);
    try {
      const clientQuery = Reflect.get(client, "query") as (...given: unknown[]) => unknown;
      const answer: unknown = await Reflect.apply(clientQuery, client, args);
      return answer;
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
