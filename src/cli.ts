import {
  migratePostgres,
  type MigratePostgresOptions,
  type MigrationReport,
} from "./migrations/migrate.js";

/**
 * `agboss-postgres` — the package's command: `migrate [--url <url>] [--schema <name>]` applies the
 * migrations not yet applied and lists them; a second run lists none. Without `--url` it reads
 * `POSTGRES_URL`, else `DATABASE_URL` (agbossjs/agboss#891: read for one more release, then gone). Usable as a Kubernetes Job:
 * exit code 0 when the schema is current, 1 when the run failed, 2 for a wrong command line.
 */

/** Where the command reads its environment and writes its lines. */
export interface CommandIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** How the command ended. */
export enum ExitCode {
  Ok = 0,
  Failed = 1,
  Usage = 2,
}

export const USAGE = `usage: agboss-postgres migrate [--url <postgres-url>] [--schema <name>]
  Applies the @agboss/postgres migrations not yet applied to the schema (created when missing;
  without --schema: the URL's search_path, public by default). Without --url: POSTGRES_URL
  (DATABASE_URL is still read when POSTGRES_URL is unset, for this release only).`;

/** The flags `migrate` takes, each with a value. */
const FLAGS: ReadonlySet<string> = new Set(["--url", "--schema"]);

/** Each `--flag value` of `rest`; a string → a usage problem. */
function flagsOf(rest: readonly string[]): ReadonlyMap<string, string> | string {
  const flags = new Map<string, string>();
  for (let at = 0; at < rest.length; at += 2) {
    const [flag, value] = [rest[at], rest[at + 1]];
    const isKnown = flag !== undefined && FLAGS.has(flag) && !flags.has(flag);
    if (!isKnown || value === undefined || value === "")
      return `unexpected arguments: ${rest.join(" ")}`;
    flags.set(flag, value);
  }
  return flags;
}

/** The URL when no `--url` is given: `POSTGRES_URL`, else (this release only) `DATABASE_URL`. */
const urlOfEnv = (env: CommandIo["env"]): string | undefined =>
  [env.POSTGRES_URL, env.DATABASE_URL].find((url) => url !== undefined && url !== "");

/** What `migrate`'s arguments ask for; a string → a usage problem. */
function targetOf(args: readonly string[], env: CommandIo["env"]): MigratePostgresOptions | string {
  const flags = flagsOf(args.slice(1));
  if (typeof flags === "string") return flags;
  const url = flags.get("--url") ?? urlOfEnv(env);
  if (url === undefined) return "no --url and no POSTGRES_URL";
  const schema = flags.get("--schema");
  return schema === undefined ? { url } : { url, schema };
}

/** The lines a run prints: what it applied, or that nothing was left. */
function reportLines(report: MigrationReport): readonly string[] {
  const lines = report.applied.map(
    (migration) =>
      `applied ${String(migration.version).padStart(4, "0")}_${migration.name} (${report.schema})`,
  );
  if (report.checkpointMigrations > 0)
    lines.push(`applied ${String(report.checkpointMigrations)} LangGraph checkpoint migration(s)`);
  if (lines.length === 0)
    lines.push(`nothing to apply: ${report.schema} is at migration ${String(report.version)}`);
  return lines;
}

/** Runs the command line `args` (without the program name); its exit code. */
export async function runCommand(args: readonly string[], io: CommandIo): Promise<ExitCode> {
  if (args[0] === "--help" || args[0] === "-h") {
    io.out(USAGE);
    return ExitCode.Ok;
  }
  const target =
    args[0] === "migrate" ? targetOf(args, io.env) : `unknown command: ${args.join(" ")}`;
  if (typeof target === "string") {
    io.err(`agboss-postgres: ${target}\n${USAGE}`);
    return ExitCode.Usage;
  }
  try {
    for (const line of reportLines(await migratePostgres(target))) io.out(line);
    return ExitCode.Ok;
  } catch (error) {
    io.err(
      `agboss-postgres: the migration failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return ExitCode.Failed;
  }
}
