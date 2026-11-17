import type pg from "pg";
import { isLostConnection } from "./outcome.js";

/**
 * `pool` whose promise `query` runs on a connection it checks out itself (agbossjs/agboss#928,
 * #1017). `pg.Pool.query` listens for the connection's `error` event and answers with that raw
 * error when the connection drops under a statement — before the `TimedClient` can read it as
 * `StoreOutcomeUnknownError`. Here the statement's own rejection is the answer. A connection that
 * is stuck, lost or past trust (an unknown outcome, postgres#113) is not given back: a caller
 * waiting for the pool gets another. A query config (`{ text, values }`) is read as its text is;
 * the callback forms and a submittable go to the pool as they are.
 */
/** A submittable (its errors are events, its answer itself): `pg.Pool`'s to run, as it is. */
const isSubmittable = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "submit" in value;

export function timedPool(pool: pg.Pool): pg.Pool {
  const poolQuery = Reflect.get(pool, "query") as (...args: unknown[]) => unknown;
  const query = async (...args: unknown[]): Promise<unknown> => {
    if (isSubmittable(args[0]) || args.some((arg) => typeof arg === "function"))
      return Reflect.apply(poolQuery, pool, args);
    // a connection that drops rejects the statement in flight, read below; its `error` event is
    // the `TrackedClient`'s to hear (`PostgresConnection`'s every client)
    const client = await pool.connect();
    let isLost = false;
    try {
      const clientQuery = Reflect.get(client, "query") as (...given: unknown[]) => unknown;
      const answer: unknown = await Reflect.apply(clientQuery, client, args);
      return answer;
    } catch (error) {
      isLost = isLostConnection(error);
      throw error;
    } finally {
      client.release(isLost);
    }
  };
  // replaceable as a method is (a wrapper, a test's spy)
  Reflect.defineProperty(pool, "query", { value: query, configurable: true, writable: true });
  return pool;
}
