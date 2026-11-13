import pg from "pg";

/**
 * agbossjs/agboss#985 — the connections a killed or frozen pod leaves inside a transaction. They
 * hold the locks of the schema's tables, and a `DROP SCHEMA` waits for them. A pod names its
 * connections by the schema it works on (`application_name`), so the teardown ends the backends of
 * its own schemas' pods, no other connection.
 */

/** The `application_name` of the pods of a fault scenario's `schema`. */
export const podApplicationName = (schema: string): string => `agboss-fault-${schema}`;

/** `url` naming its connections `application_name` (the pods' URL). */
export function urlNamed(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", name);
  return parsed.toString();
}

/** Ends the backends of the pods of `schemas`, on the server at `url`; how many. */
export async function endPodBackends(url: string, schemas: readonly string[]): Promise<number> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const ended = await client.query<{ pid: number }>(
      `SELECT pg_terminate_backend(pid) AS ended, pid FROM pg_stat_activity
       WHERE application_name = ANY($1) AND pid <> pg_backend_pid()`,
      [schemas.map(podApplicationName)],
    );
    return ended.rowCount ?? 0;
  } finally {
    await client.end();
  }
}
