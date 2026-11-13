import pg from "pg";

/**
 * agbossjs/agboss#985 — a test file's teardown: every schema it made dropped in bounded parallel,
 * each drop on a connection of its own with a bound of its own. `DROP SCHEMA ... CASCADE` waits for
 * the locks of its tables, and a pod killed or frozen inside a transaction holds them until the
 * server sees its connection gone: dropped one after another, a few such schemas outlast any hook.
 * A drop that does not finish is reported by name, never thrown (a suite whose tests passed does
 * not fail on its cleanup), and never silent: the leaked schemas are counted.
 */

/** One drop's bound, ms: the server's `lock_timeout` and `statement_timeout`; the client gives up a little later. */
export const DROP_BOUND_MS = 20_000;

/** How many drops run at once. */
export const DROP_CONCURRENCY = 4;

/** The time the client waits beyond the server's bound, for the server's own error to come first. */
const CLIENT_GRACE_MS = 5_000;

/** A drop of one schema, given its bound in ms. */
export type DropOne = (schema: string, boundMs: number) => Promise<void>;

/** A schema that was not dropped, and why. */
export interface DropFailure {
  readonly schema: string;
  readonly reason: string;
}

/** What a teardown did: how many were dropped, which leaked. */
export interface DropReport {
  readonly dropped: number;
  readonly leaked: readonly DropFailure[];
}

/** The hook timeout of a teardown of at most `count` schemas: every wave of drops at its bound. */
export const teardownTimeout = (count: number, concurrency = DROP_CONCURRENCY): number =>
  Math.ceil(count / concurrency) * (DROP_BOUND_MS + CLIENT_GRACE_MS) + CLIENT_GRACE_MS;

/** `schema` dropped on the server at `url` within `boundMs`, on a connection of its own. */
export const dropOnServer =
  (url: string): DropOne =>
  async (schema, boundMs) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`SET lock_timeout = ${String(boundMs)}`);
      await client.query(`SET statement_timeout = ${String(boundMs)}`);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  };

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `task`, or a rejection after `ms`. */
async function within(task: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer in ${String(ms)} ms`));
    }, ms);
  });
  try {
    await Promise.race([task, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Drops `schemas`, at most `concurrency` at once, each within `boundMs`; never rejects. */
export async function dropSchemas(
  schemas: readonly string[],
  drop: DropOne,
  options: { readonly boundMs?: number; readonly concurrency?: number } = {},
): Promise<DropReport> {
  const boundMs = options.boundMs ?? DROP_BOUND_MS;
  const queue = [...schemas];
  const leaked: DropFailure[] = [];
  let dropped = 0;
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      try {
        await within(drop(next, boundMs), boundMs + CLIENT_GRACE_MS);
        dropped += 1;
      } catch (error) {
        leaked.push({ schema: next, reason: describe(error) });
      }
    }
  };
  const width = Math.min(options.concurrency ?? DROP_CONCURRENCY, schemas.length);
  await Promise.all(Array.from({ length: width }, worker));
  return { dropped, leaked };
}

/** The report as lines for a log: empty when nothing leaked; else the count and every schema by name. */
export function leakLines(report: DropReport): string[] {
  if (report.leaked.length === 0) return [];
  const total = report.dropped + report.leaked.length;
  return [
    `${String(report.leaked.length)} of ${String(total)} test schemas leaked (not dropped):`,
    ...report.leaked.map(({ schema, reason }) => `  ${schema}: ${reason}`),
  ];
}

/** Drops `schemas` on the server at `url` and warns of every leak; the report, for a test to read. */
export async function teardownSchemas(
  url: string,
  schemas: readonly string[],
): Promise<DropReport> {
  const report = await dropSchemas(schemas, dropOnServer(url));
  for (const line of leakLines(report)) process.stderr.write(`${line}\n`);
  return report;
}
