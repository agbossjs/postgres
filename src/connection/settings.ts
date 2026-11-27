import type { SchemaSetup } from "@agboss/core/stores";
import { PostgresSettingsError } from "../errors.js";

/** The pool's size when the driver gives no `poolSize`. */
export const DEFAULT_POOL_SIZE = 10;

/**
 * How long a dead `LISTEN` connection may go unnoticed (agbossjs/agboss#789) when the driver
 * gives no `watchLiveness`: a ping every half of it, an answer due within the
 * other half.
 */
export const DEFAULT_WATCH_LIVENESS_SECONDS = 10;

/**
 * The longest liveness bound the watch accepts, in seconds (agbossjs/agboss#1129): an hour, far
 * under the 2^31-1 ms (about 24.8 days) a Node timer holds — beyond it the timer fires at once, the
 * watch fails and the instance silently falls back to the sweep.
 */
export const MAX_WATCH_LIVENESS_SECONDS = 3600;

/**
 * `seconds` when the child queue's watch can run on it — a whole number from 2 to `MAX_WATCH_LIVENESS_SECONDS`, as the
 * driver's option is checked —, else `PostgresSettingsError` naming `watchLivenessSeconds`
 * (agbossjs/agboss#1029): a settings object a script or a provider builds is trusted no more than
 * the driver's options.
 */
export function checkedWatchLivenessOf(seconds: number | undefined): number | undefined {
  if (
    seconds === undefined ||
    (Number.isInteger(seconds) && seconds >= 2 && seconds <= MAX_WATCH_LIVENESS_SECONDS)
  )
    return seconds;
  throw new PostgresSettingsError({
    message: `watchLivenessSeconds must be a whole number of at least 2 and at most ${String(MAX_WATCH_LIVENESS_SECONDS)}, got ${String(seconds)}`,
  });
}

/**
 * How long a store command may run when the driver gives no `commandTimeout`
 * (agbossjs/agboss#928): the server cancels a statement past it (`statement_timeout`), the client
 * gives up on a silent server a second later (`query_timeout`). Below the framework's own 15 s
 * bound, so a command that does not answer ends as `StoreError.CallTimeout` with the driver's error
 * as its cause, never as the framework's give-up.
 */
export const DEFAULT_COMMAND_TIMEOUT = 10_000;

/**
 * How long a retention's delete (`delete…Before`) may run (agbossjs/agboss#928), in ms: 5 minutes,
 * the framework's own bound of those calls. Not configurable: a retention that needs longer deletes
 * in smaller steps.
 */
export const LONG_COMMAND_TIMEOUT = 300_000;

/**
 * How long a session may sit idle inside a transaction when the driver gives no
 * `idleInTransactionTimeout` (agbossjs/agboss#928, #909): the server ends the session and
 * frees what it locked. A frozen or abandoned lease holder inside a fencing transaction holds the
 * lease row's lock; `requestCancel` and a takeover wait on that row and `app.cancel` is bounded at
 * 15 s, so the default is 10 s, not the lease. A fenced work that idles longer between its
 * statements is ended and fails rolled back (a known outcome).
 */
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT = 10_000;

/** The range of a command timeout, in ms: below it nothing could finish, above it the framework's bound fires first. */
export const MIN_COMMAND_TIMEOUT = 100;
export const MAX_COMMAND_TIMEOUT = 30_000;

/**
 * `value` when it is a whole number of ms from `MIN_COMMAND_TIMEOUT` to `MAX_COMMAND_TIMEOUT`, else
 * `PostgresSettingsError` naming `field` (agbossjs/agboss#928): 0 waits forever, which the stores
 * never do. A settings object is trusted no more than the driver's options.
 */
export function checkedTimeoutOf(field: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (Number.isInteger(value) && value >= MIN_COMMAND_TIMEOUT && value <= MAX_COMMAND_TIMEOUT)
    return value;
  throw new PostgresSettingsError({
    message: `${field} must be a whole number of milliseconds from ${String(MIN_COMMAND_TIMEOUT)} to ${String(MAX_COMMAND_TIMEOUT)}, got ${String(value)}`,
  });
}

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
  /**
   * The longest a silently dead `LISTEN` connection of the child queue's watch (a half-open TCP
   * connection: no FIN, no RST) goes unnoticed, in seconds (agbossjs/agboss#789; default
   * `DEFAULT_WATCH_LIVENESS_SECONDS`, 10, at least 2, at most `MAX_WATCH_LIVENESS_SECONDS`, 3600): the watch pings its connection every half of
   * it and gives the answer the other half, then warns, listens again on a new connection and wakes
   * once.
   * Another value (0, 1, a negative or a fractional number, or one above 3600) is a `PostgresSettingsError` at construction
   * (agbossjs/agboss#1029), as in the driver.
   */
  readonly watchLivenessSeconds?: number;
  /**
   * How long a store command may run, in ms (agbossjs/agboss#928; default `DEFAULT_COMMAND_TIMEOUT`,
   * 10 000; 100 to 30 000): the pool's `statement_timeout`, and `query_timeout` a second later. A
   * command past it fails as `StoreError.CallTimeout` (`store.call-timeout`, source `Command`), its
   * outcome unknown. Another value (0, a negative or a fractional number) is a `PostgresSettingsError`.
   */
  readonly commandTimeout?: number;
  /**
   * How long a session may idle inside a transaction, in ms (agbossjs/agboss#928; default
   * `DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT`, 10 000; 100 to 30 000): the pool's
   * `idle_in_transaction_session_timeout`.
   */
  readonly idleInTransactionTimeout?: number;
  /** What the start does with the schema (default `SchemaSetup.Check`: it is migrated explicitly). */
  readonly schemaSetup?: SchemaSetup;
  /**
   * With `SchemaSetup.MigrateOnStart` and migrations pending, the start waits for the execution
   * leases of the old instances to lapse (twice the longest lease left, at least a minute, at most ten) and fails with `PostgresLiveLeasesError` while one
   * is live (agbossjs/agboss#1104: no rolling upgrade across a schema change — stop the old
   * instances first). `true` migrates over live leases: for an operator who accepts the risk. The
   * migrate command's `--allow-live-leases`.
   */
  readonly allowLiveLeases?: boolean;
}

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
  if (schema.length === 0) throw new PostgresSettingsError({ message: "the schema name is empty" });
  if (!SCHEMA_NAME.test(schema))
    throw new PostgresSettingsError({
      message:
        "the schema name must be a plain lowercase identifier — a-z, 0-9 and _, not starting with a digit, at most 63 characters",
    });
  return schema;
}

/** `schema` quoted as an SQL identifier: `"app_a"`, `"we""ird"`. */
export const quotedIdentifier = (schema: string): string => `"${schema.replaceAll('"', '""')}"`;

/** The connection's startup `options` that put every statement of the session in `schema` (checked). */
export const searchPathOptionOf = (schema: string): string =>
  `-c search_path=${quotedIdentifier(schema)}`;

/**
 * The session's time zone, UTC (agbossjs/agboss#1307): a `timestamptz` is the same instant whatever
 * the zone, but a cast to text is not (`expires_at::text` reads `+02` under `+02`), so every `::text`
 * of a migration or of a human's `psql` is the framework's spelling.
 */
export const UTC_OPTION = "-c timezone=UTC";

/**
 * The startup `options` of every session the package opens: UTC, and `schema`'s `search_path` when
 * one is given (checked).
 */
export const sessionOptionsOf = (schema: string | undefined): string =>
  schema === undefined ? UTC_OPTION : `${UTC_OPTION} ${searchPathOptionOf(schema)}`;
