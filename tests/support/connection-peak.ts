import pg from "pg";

/**
 * agbossjs/agboss#978 AC1: the most client connections the run holds on its database at once,
 * sampled by one connection of its own. The server's `max_connections` is 100 (CI's service
 * container), 3 of them kept for superusers: the run stays far enough under it that a file's
 * burst, or a developer's second run on the same server, never meets "too many clients".
 */
export const PEAK_CONNECTION_BOUND = 60;

const SAMPLE_MS = 25;

/** The sampling's result: the peak seen, and the count of samples it took. */
export interface ConnectionPeak {
  readonly peak: number;
  readonly samples: number;
  /** The connections at the peak, by the application name of the test file that opened them. */
  readonly holders: Readonly<Record<string, number>>;
}

/** Starts sampling the client connections of `url`'s database; `stop` ends it with the peak. */
export async function sampleConnections(url: string): Promise<() => Promise<ConnectionPeak>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let peak = 0;
  let samples = 0;
  let holders: Record<string, number> = {};
  const sampling = { isOn: true };
  const loop = (async () => {
    while (sampling.isOn) {
      const { rows } = await client.query<{ name: string; n: number }>(
        `SELECT application_name AS name, count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
         GROUP BY application_name`,
      );
      const now = rows.reduce((sum, row) => sum + row.n, 0);
      if (now > peak) {
        peak = now;
        holders = Object.fromEntries(rows.map((row) => [row.name, row.n]));
      }
      samples += 1;
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
    }
  })();
  return async () => {
    sampling.isOn = false;
    await loop;
    await client.end();
    return { peak, samples, holders };
  };
}
