import type pg from "pg";

/**
 * Every session of the package is in UTC (agbossjs/agboss#1307): the startup option
 * `-c timezone=UTC` (`sessionOptionsOf`) does it, but a URL that carries `options` of its own
 * overrides the config's, so the statement is sent on every connection too. A `timestamptz` is the
 * same instant in any zone; a cast to text is not, and every `::text` of a migration or of a human's
 * `psql` is the framework's spelling only in UTC.
 */
export const SET_UTC = "SET TIME ZONE 'UTC'";

/**
 * `pool`, every connection it opens sent `SET_UTC` first: the statement is queued on the connection
 * before anything the pool lends it runs. A connection that cannot take it is a connection the next
 * statement fails on by itself, so the rejection is not reported twice.
 */
export function utcPoolOf<TPool extends pg.Pool>(pool: TPool): TPool {
  pool.on("connect", (client) => {
    client.query(SET_UTC).catch(() => undefined);
  });
  return pool;
}

/** `client`, connected, in UTC. */
export async function connectedInUtc(client: pg.Client): Promise<void> {
  await client.connect();
  await client.query(SET_UTC);
}
