import { z } from "zod";
import { PostgresSettingsError } from "../errors.js";

/** The pool's size when the environment does not set `postgresPoolSize`. */
export const DEFAULT_POOL_SIZE = 10;

/** What one application instance's connection is made of. */
export interface PostgresConnectionSettings {
  /** The database: `postgres://user:password@host:5432/database`. */
  readonly url: string;
  /** The most connections the instance's pool opens (default 10). */
  readonly poolSize?: number;
  /** Whether the start migrates a database that lacks this package's migrations (default off). */
  readonly migrateOnStart?: boolean;
}

/** A `Secret` of the environment: only `reveal()` gives its value. */
interface RevealedSecret {
  reveal(): string;
}

const isSecret = (value: unknown): value is RevealedSecret =>
  typeof value === "object" &&
  value !== null &&
  "reveal" in value &&
  typeof value.reveal === "function";

/** The fields the PostgreSQL stores read from the application's environment. */
const PostgresEnvironment = z.object({
  postgresUrl: z.custom<RevealedSecret>(isSecret, {
    message: 'postgresUrl must be a Secret: postgresUrl: secret("DATABASE_URL")',
  }),
  postgresPoolSize: z
    .number({ message: "postgresPoolSize must be a number" })
    .int("postgresPoolSize must be a whole number")
    .min(1, "postgresPoolSize must be at least 1")
    .optional(),
  postgresMigrateOnStart: z
    .boolean({ message: "postgresMigrateOnStart must be a flag" })
    .optional(),
});

const MISSING_URL =
  'postgresUrl is missing: declare postgresUrl!: Secret in the environment contract and set postgresUrl: secret("DATABASE_URL")';

/**
 * The connection settings an application's environment gives: `postgresUrl` (required, a
 * `Secret`), `postgresPoolSize` and `postgresMigrateOnStart` (optional). A missing or mistyped
 * field fails with `PostgresSettingsError`, naming it — the URL itself is never printed.
 */
export function settingsOfEnvironment(environment: unknown): PostgresConnectionSettings {
  const parsed = PostgresEnvironment.safeParse(environment);
  if (!parsed.success) {
    const isUrlMissing = Reflect.get(Object(environment), "postgresUrl") === undefined;
    const problems = parsed.error.issues.map((issue) =>
      issue.path[0] === "postgresUrl" && isUrlMissing ? MISSING_URL : issue.message,
    );
    throw new PostgresSettingsError(
      `the PostgreSQL stores need their environment fields — ${problems.join("; ")}`,
    );
  }
  const { postgresUrl, postgresPoolSize, postgresMigrateOnStart } = parsed.data;
  const url = postgresUrl.reveal();
  if (url.length === 0) throw new PostgresSettingsError("postgresUrl is empty");
  return { url, poolSize: postgresPoolSize, migrateOnStart: postgresMigrateOnStart };
}
