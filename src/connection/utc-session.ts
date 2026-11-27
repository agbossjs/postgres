import type pg from "pg";
import { quotedIdentifier } from "./settings.js";

/**
 * The session every connection of the package is in (agbossjs/agboss#1307): UTC, and — when a schema
 * is configured — that schema's `search_path`. Both are statements sent on the connection, not
 * startup `options`: a URL that carries `options` of its own (Neon's `endpoint=…`, a
 * `statement_timeout`) overrides the config's, which would silently run the stores in the URL's
 * `search_path` and in another time zone; and a pooler (PgBouncer) may refuse the `options` startup
 * parameter altogether. A `timestamptz` is the same instant in any zone and no statement of the
 * stores compares or keys by a cast of one to text, so correctness never rests on the session zone;
 * UTC is for every `::text` of a migration or of a human's `psql`.
 */
export const SET_UTC = "SET TIME ZONE 'UTC'";

/** The statements that put a session in UTC and in `schema` (checked; none when there is none). */
export const sessionStatementsOf = (schema: string | undefined): readonly string[] =>
  schema === undefined ? [SET_UTC] : [SET_UTC, `SET search_path TO ${quotedIdentifier(schema)}`];

/** `client`, in the session `sessionStatementsOf(schema)` names; a statement that fails rejects. */
export async function inSession(client: pg.ClientBase, schema: string | undefined): Promise<void> {
  for (const statement of sessionStatementsOf(schema)) await client.query(statement);
}

/** pg's type of the pool's `onConnect`: it says `void`, pg-pool awaits what it returns. */
export type OnConnect = NonNullable<pg.PoolConfig["onConnect"]>;

/**
 * The pool option that sets every connection up before the pool lends it (pg-pool's awaited
 * `onConnect`): a connection that cannot take the statements is ended and the checkout fails with
 * the statement's error — never lent in the wrong zone or schema.
 */
export const onConnectOf =
  (schema: string | undefined): OnConnect =>
  (client) =>
    inSession(client, schema);
