import { migratePostgres, type MigrationReport } from "./migrations/migrate.js";

/**
 * `agboss-postgres` — the package's command: `migrate --url <url>` (or `DATABASE_URL`) applies the
 * migrations not yet applied and lists them; a second run lists none. Usable as a Kubernetes Job:
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

export const USAGE = `usage: agboss-postgres migrate [--url <postgres-url>]
  Applies the @agboss/postgres migrations not yet applied (DATABASE_URL when --url is not given).`;

/** The URL of `migrate`'s arguments; a string → a usage problem. */
function urlOf(args: readonly string[], env: CommandIo["env"]): { readonly url: string } | string {
  const rest = args.slice(1);
  if (rest.length === 0) {
    const url = env.DATABASE_URL;
    return url === undefined || url === "" ? "no --url and no DATABASE_URL" : { url };
  }
  const [flag, url, ...extra] = rest;
  if (flag !== "--url" || url === undefined || url === "" || extra.length > 0)
    return `unexpected arguments: ${rest.join(" ")}`;
  return { url };
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
  const target = args[0] === "migrate" ? urlOf(args, io.env) : `unknown command: ${args.join(" ")}`;
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
