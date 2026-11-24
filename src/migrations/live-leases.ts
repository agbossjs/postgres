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
  /** The longest time a live lease has left, ms (0 when none is live). */
  remaining: z.coerce.number(),
});

/** The leases that are live: not released, finished or superseded, and not yet expired on the database's clock. */
const LIVE = "NOT released AND NOT finished AND NOT superseded AND expires_at > clock_timestamp()";

/** The live leases of the schema: how many, up to five holders, the longest time left. */
async function liveLeasesOf(client: ClientBase): Promise<z.infer<typeof LiveRow>> {
  const { rows } = await client.query(
    `WITH live AS (SELECT holder_instance_id, expires_at FROM agboss_execution_leases WHERE ${LIVE})
     SELECT (SELECT count(*) FROM live) AS count,
       COALESCE((SELECT array_agg(holder) FROM (
         SELECT DISTINCT holder_instance_id AS holder FROM live ORDER BY holder LIMIT $1
       ) AS sample), ARRAY[]::text[]) AS holders,
       COALESCE((SELECT max(extract(epoch FROM expires_at - clock_timestamp()) * 1000) FROM live), 0) AS remaining`,
    [SAMPLE_HOLDERS],
  );
  return LiveRow.parse(rows[0]);
}

/** Throws `PostgresLiveLeasesError` when an execution lease is live (the baseline's lease table exists). */
export async function refuseLiveLeases(client: ClientBase): Promise<void> {
  const { count, holders } = await liveLeasesOf(client);
  if (count > 0) throw new PostgresLiveLeasesError({ count, holders });
}

/** How long a start that migrates waits for live leases to lapse (at least `maxMs`, at most `capMs`), and how often it looks. */
export interface LeaseWait {
  readonly maxMs: number;
  readonly pollMs: number;
  /** The longest wait a long lease asks for: past it the start refuses (default 10 minutes). */
  readonly capMs?: number;
}

/** The longest wait of all: a lease that outlasts it (5 minutes and more) is refused, not waited for. */
const DEFAULT_CAP_MS = 600_000;

/**
 * The default wait: twice the core's default lease duration (30 s) — a stopped single instance's
 * own leases lapse within it, a running old instance renews its leases and outlasts it.
 */
export const DEFAULT_LEASE_WAIT: LeaseWait = { maxMs: 60_000, pollMs: 1_000 };

/**
 * How long the start waits, given the longest time a live lease has left: twice that, when it is
 * more than the default. A holder renews its lease long before it ends, so what is left of it is
 * at least three quarters of its duration: twice the remainder outlasts the lapse of a stopped
 * instance whatever its lease duration is (a custom 45 s lease waits 90 s). The default is the
 * floor and ten minutes the cap (agbossjs/agboss#1104: the lease duration is the holder's, the
 * database shows it).
 */
export const leaseWaitFor = (remainingMs: number, wait: LeaseWait): number =>
  Math.max(wait.maxMs, Math.min(2 * remainingMs, wait.capMs ?? DEFAULT_CAP_MS));

/**
 * A start that migrates (`SchemaSetup.MigrateOnStart`, agbossjs/agboss#1104): looks for a live lease
 * every `pollMs` for `leaseWaitFor(...)`, on the database's clock; one that lapses lets the start go
 * on, one still live at the end fails it with `PostgresLiveLeasesError` (the old instances are not
 * stopped: stop them first). The attempts are counted, not timed: no host clock decides.
 */
export async function waitForLeasesToLapse(client: ClientBase, wait: LeaseWait): Promise<void> {
  const first = await liveLeasesOf(client);
  if (first.count === 0) return;
  const attempts = Math.max(1, Math.ceil(leaseWaitFor(first.remaining, wait) / wait.pollMs));
  for (let attempt = 1; ; attempt += 1) {
    // the database waits (`pg_sleep`): no host clock, no timer of the process
    await client.query("SELECT pg_sleep($1)", [wait.pollMs / 1000]);
    const live = await liveLeasesOf(client);
    if (live.count === 0) return;
    if (attempt >= attempts)
      throw new PostgresLiveLeasesError({ count: live.count, holders: live.holders });
  }
}
