import { SchemaSetup } from "@agboss/core/stores";
import { z } from "zod";
import { PostgresSettingsError } from "../errors.js";

/** The pool's size when the environment does not set `postgresPoolSize`. */
export const DEFAULT_POOL_SIZE = 10;

/**
 * The schema the stores' tables are in when neither `schema` nor the URL's `search_path` names one
 * (agbossjs/agboss#891): PostgreSQL's own default.
 */
export const DEFAULT_SCHEMA = "public";

/** What one application instance's connection is made of. */
export interface PostgresConnectionSettings {
  /** The database: `postgres://user:password@host:5432/database`. */
  readonly url: string;
  /** The most connections the instance's pool opens (default `DEFAULT_POOL_SIZE`, 10). */
  readonly poolSize?: number;
  /**
   * The schema of the stores' tables (agbossjs/agboss#891): two applications on one database, each
   * in its own. Unset → the URL's `search_path`, else `DEFAULT_SCHEMA`. Migrate it with
   * `migratePostgres({ url, schema })` / `agboss-postgres migrate --schema <name>`.
   */
  readonly schema?: string;
  /** What the start does with the schema (default `SchemaSetup.Check`: it is migrated explicitly). */
  readonly schemaSetup?: SchemaSetup;
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

const SCHEMA_SETUPS = Object.values(SchemaSetup).join(", ");

/** The fields the PostgreSQL stores read from the application's environment. */
const PostgresEnvironment = z.object({
  postgresUrl: z.custom<RevealedSecret>(isSecret, {
    message: 'postgresUrl must be a Secret: postgresUrl: secret("POSTGRES_URL")',
  }),
  postgresPoolSize: z
    .number({ message: "postgresPoolSize must be a number" })
    .int("postgresPoolSize must be a whole number")
    .min(1, "postgresPoolSize must be at least 1")
    .optional(),
  postgresSchema: z.string({ message: "postgresSchema must be a text" }).optional(),
  postgresSchemaSetup: z
    .enum(SchemaSetup, { message: `postgresSchemaSetup must be one of: ${SCHEMA_SETUPS}` })
    .optional(),
});

const MISSING_URL =
  'postgresUrl is missing: declare postgresUrl!: Secret in the environment contract and set postgresUrl: secret("POSTGRES_URL")';

/**
 * A schema name the stores accept: a plain lowercase identifier of at most 63 bytes (PostgreSQL's
 * limit, beyond which it cuts the name silently). LangGraph's checkpoint saver writes the name into
 * its SQL unquoted, so an unquoted identifier is the only kind every statement reads the same way —
 * a quote, a space or an upper-case letter is refused before any SQL, never run.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;

/** `schema` when the stores accept it (`SCHEMA_NAME`), else `PostgresSettingsError`. */
export function checkedSchemaOf(schema: string | undefined): string | undefined {
  if (schema === undefined) return undefined;
  if (schema.length === 0) throw new PostgresSettingsError("the schema name is empty");
  if (!SCHEMA_NAME.test(schema))
    throw new PostgresSettingsError(
      "the schema name must be a plain lowercase identifier — a-z, 0-9 and _, not starting with a digit, at most 63 characters",
    );
  return schema;
}

/** `schema` quoted as an SQL identifier: `"app_a"`, `"we""ird"`. */
export const quotedIdentifier = (schema: string): string => `"${schema.replaceAll('"', '""')}"`;

/** The connection's startup `options` that put every statement of the session in `schema` (checked). */
export const searchPathOptionOf = (schema: string): string =>
  `-c search_path=${quotedIdentifier(schema)}`;

/**
 * The connection settings an application's environment gives: `postgresUrl` (required, a
 * `Secret`), `postgresPoolSize`, `postgresSchema` and `postgresSchemaSetup` (optional). A missing or
 * mistyped field fails with `PostgresSettingsError`, naming it — the URL itself is never printed.
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
  const { postgresUrl, postgresPoolSize, postgresSchema, postgresSchemaSetup } = parsed.data;
  const url = postgresUrl.reveal();
  if (url.length === 0) throw new PostgresSettingsError("postgresUrl is empty");
  return {
    url,
    poolSize: postgresPoolSize,
    schema: checkedSchemaOf(postgresSchema),
    schemaSetup: postgresSchemaSetup,
  };
}
