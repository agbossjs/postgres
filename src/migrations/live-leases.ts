import type { ClientBase } from "pg";
import { z } from "zod";
import { PostgresLiveLeasesError } from "../errors.js";

/**
 * The guard of a schema upgrade (agbossjs/agboss#1104, ADR-0034): the leases live on the database's
 * clock — not released, finished or superseded, `expires_at` after `clock_timestamp()` — belong to
 * instances of the version being replaced (a new one cannot start before the migration), so a run
 * that applies migrations refuses while one exists.
 */

/** How many holders the error names. */
const SAMPLE_HOLDERS = 5;

const LiveRow = z.object({
  count: z.coerce.number(),
  holders: z.array(z.string()),
});

/** The migrations that added the lease columns the guard reads: `superseded` (0014), `finished` (0017). */
const SUPERSEDED_FROM = 14;
const FINISHED_FROM = 17;

/** Which leases are live in a schema at migration `applied` (a column not added yet closes nothing). */
const liveOf = (applied: number): string =>
  [
    "NOT released",
    ...(applied >= FINISHED_FROM ? ["NOT finished"] : []),
    ...(applied >= SUPERSEDED_FROM ? ["NOT superseded"] : []),
    "expires_at > clock_timestamp()",
  ].join(" AND ");

/**
 * Throws `PostgresLiveLeasesError` when an execution lease is live: `applied` is the schema's newest
 * migration (at least 1: the lease table exists).
 */
export async function refuseLiveLeases(client: ClientBase, applied: number): Promise<void> {
  const { rows } = await client.query(
    `WITH live AS (SELECT holder_instance_id FROM agboss_execution_leases WHERE ${liveOf(applied)})
     SELECT (SELECT count(*) FROM live) AS count,
       COALESCE((SELECT array_agg(holder) FROM (
         SELECT DISTINCT holder_instance_id AS holder FROM live ORDER BY holder LIMIT $1
       ) AS sample), ARRAY[]::text[]) AS holders`,
    [SAMPLE_HOLDERS],
  );
  const live = LiveRow.parse(rows[0]);
  if (live.count > 0) throw new PostgresLiveLeasesError(live);
}

/** How long a start that migrates waits for live leases to lapse, and how often it looks. */
export interface LeaseWait {
  readonly maxMs: number;
  readonly pollMs: number;
}

/**
 * The default wait: twice the core's default lease duration (30 s) — a stopped single instance's
 * own leases lapse within it, a running old instance renews its leases and outlasts it.
 */
export const DEFAULT_LEASE_WAIT: LeaseWait = { maxMs: 60_000, pollMs: 1_000 };

/**
 * A start that migrates (`SchemaSetup.MigrateOnStart`, agbossjs/agboss#1104): looks for a live lease
 * every `pollMs` for `maxMs`, on the database's clock; one that lapses lets the start go on, one
 * still live at the end fails it with `PostgresLiveLeasesError` (the old instances are not stopped:
 * stop them first). The attempts are counted, not timed: no host clock decides.
 */
export async function waitForLeasesToLapse(
  client: ClientBase,
  applied: number,
  wait: LeaseWait,
): Promise<void> {
  const attempts = Math.max(1, Math.ceil(wait.maxMs / wait.pollMs));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await refuseLiveLeases(client, applied);
      return;
    } catch (error) {
      if (!(error instanceof PostgresLiveLeasesError) || attempt >= attempts) throw error;
    }
    // the database waits (`pg_sleep`): no host clock, no timer of the process
    await client.query("SELECT pg_sleep($1)", [wait.pollMs / 1000]);
  }
}
