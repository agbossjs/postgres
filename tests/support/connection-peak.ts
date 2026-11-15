import pg from "pg";

/**
 * agbossjs/agboss#978 AC1 — the most connections the suite holds open at once on its database,
 * sampled from `pg_stat_activity` for the whole run (the global setup starts it, its teardown fails
 * the run over the bound). CI's PostgreSQL has `max_connections = 100`, and the failure at the limit
 * (`sorry, too many clients already`) hit a test that did nothing wrong. Every pool in the tests is
 * bounded (`poolSize`), the files run on `vitest`'s workers side by side, and the process and fault
 * tests start pods with pools of their own: the bound states what all of them add up to.
 */

/** What the suite may hold at once: well under CI's `max_connections` (100), a margin for the server's own. */
export const PEAK_BOUND = 60;

/** How often the connections are counted. */
const SAMPLE_EVERY_MS = 25;

/** The count of connections on the sampled database, and the most it was seen at. */
export interface ConnectionPeak {
  /** The most connections (the sampler's own included) seen on the database so far. */
  readonly peak: () => number;
  /** Stops sampling, answering the peak. */
  readonly stop: () => Promise<number>;
}

/** Starts counting the connections to the database `url` names. */
export async function sampleConnections(url: string): Promise<ConnectionPeak> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let peak = 0;
  const count = async (): Promise<void> => {
    const { rows } = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_stat_activity WHERE datname = current_database()",
    );
    peak = Math.max(peak, Number(rows[0]?.count ?? 0));
  };
  await count();
  // one count at a time: a slow answer is not stacked on
  let counting: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    counting = counting.then(count).catch(() => undefined);
  }, SAMPLE_EVERY_MS);
  return {
    peak: () => peak,
    stop: async () => {
      clearInterval(timer);
      await counting;
      await count().catch(() => undefined);
      await client.end().catch(() => undefined);
      return peak;
    },
  };
}

/** Throws, naming both numbers, when `peak` is over `bound`. */
export function assertPeakUnder(peak: number, bound: number): void {
  if (peak > bound)
    throw new Error(
      `the suite held ${String(peak)} connections at once, over the bound of ${String(bound)} ` +
        `(CI's PostgreSQL refuses at max_connections = 100): bound the pools of the test that opens them (agbossjs/agboss#978)`,
    );
}
