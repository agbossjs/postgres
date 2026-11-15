import { AGBossError } from "@agboss/core";
import type { MigrationReport } from "./migrations/migrate.js";

/**
 * The errors of `@agboss/postgres`: each an `AGBossError` with a stable `code`, so an operator's
 * start-up script and a test tell them apart. A store's own failure (a lost connection, a
 * constraint) is the driver's error, rethrown as it is: the operation rejects, the core's
 * hand-over rules apply.
 */

/** What a schema check found: the newest migration applied, the newest one this package ships. */
export interface SchemaVersions {
  /** The newest migration applied to the database (0: none, or no history table). */
  readonly applied: number;
  /** The newest migration of this package. */
  readonly expected: number;
  /** What made the check fail, when it has one. */
  readonly cause?: unknown;
}

/** The command an operator runs to migrate, as an error message names it. */
export const MIGRATE_COMMAND = "npx agboss-postgres migrate";

/**
 * The database lacks migrations of this package (none applied, or older ones only) and the
 * start's setup is `SchemaSetup.Check` (the default): the application does not start. Run the
 * migrations (`agboss-postgres migrate`, a Kubernetes Job) or set `postgresSchemaSetup:
 * SchemaSetup.MigrateOnStart`.
 */
export class PostgresSchemaMissingError extends AGBossError {
  static override readonly code = "postgres.schema-missing" as const;
  declare readonly code: typeof PostgresSchemaMissingError.code;
  override name = "PostgresSchemaMissingError";
  readonly applied: number;
  readonly expected: number;

  constructor(versions: SchemaVersions) {
    super(
      `the PostgreSQL schema is at migration ${String(versions.applied)}, this package needs ${String(versions.expected)}: run \`${MIGRATE_COMMAND}\` with POSTGRES_URL set (add --schema <name> for the application's postgresSchema; or set postgresSchemaSetup: SchemaSetup.MigrateOnStart in the environment)`,
      { cause: versions.cause },
    );
    this.applied = versions.applied;
    this.expected = versions.expected;
  }
}

/**
 * The database was migrated by a newer version of this package than the one running: an
 * application rolled back over a migrated database. Deploy the newer application again — the
 * migrations are never rolled back.
 */
export class PostgresSchemaTooNewError extends AGBossError {
  static override readonly code = "postgres.schema-too-new" as const;
  declare readonly code: typeof PostgresSchemaTooNewError.code;
  override name = "PostgresSchemaTooNewError";
  readonly applied: number;
  readonly expected: number;

  constructor(versions: SchemaVersions) {
    super(
      `the PostgreSQL schema is at migration ${String(versions.applied)}, newer than this package's ${String(versions.expected)}: a newer @agboss/postgres migrated it — deploy that version, the migrations are not rolled back`,
      { cause: versions.cause },
    );
    this.applied = versions.applied;
    this.expected = versions.expected;
  }
}

/** Which migration changed after it was applied. */
export interface ChangedMigration {
  readonly version: number;
  /** The migration's file name. */
  readonly migration: string;
  readonly cause?: unknown;
}

/**
 * A migration applied to the database differs from the package's file of that version (its name
 * or its SHA-256): the files were edited after a release. Nothing is applied — restore the file;
 * a change of schema is a new migration.
 */
export class PostgresMigrationChangedError extends AGBossError {
  static override readonly code = "postgres.migration-changed" as const;
  declare readonly code: typeof PostgresMigrationChangedError.code;
  override name = "PostgresMigrationChangedError";
  readonly version: number;
  readonly migration: string;

  constructor(changed: ChangedMigration) {
    super(
      `migration ${String(changed.version)} (${changed.migration}) was applied with another name or checksum than this package's file: restore the file — a schema change is a new migration`,
      { cause: changed.cause },
    );
    this.version = changed.version;
    this.migration = changed.migration;
  }
}

/** What a refused setting takes: the message, and what made it fail when it has a cause. */
export interface PostgresSettingsErrorOptions {
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The environment does not give what a PostgreSQL store needs: `postgresUrl` (a `Secret`), and
 * when set, `postgresPoolSize` (a whole number from 1), `postgresSchema` (a schema name: not empty,
 * no NUL, at most 63 bytes) and `postgresSchemaSetup` (a `SchemaSetup`).
 */
export class PostgresSettingsError extends AGBossError {
  static override readonly code = "postgres.settings-invalid" as const;
  declare readonly code: typeof PostgresSettingsError.code;
  override name = "PostgresSettingsError";

  constructor(options: PostgresSettingsErrorOptions) {
    super(options.message, options);
  }
}

/** What a missing ledger mark takes: only a cause. */
export interface PostgresLedgerMarkMissingErrorOptions {
  readonly cause?: unknown;
}

/**
 * The ledger's pruning mark (agbossjs/agboss#771, the one row of `agboss_cost_entries_pruned` that
 * migration 0023 seeds) is gone — deleted by hand: without it a save cannot tell an entry the ledger
 * pruned from a new one, so it adds nothing and fails. Put the row back with a mark no lower than
 * any prune's cutoff (`now − retention.costLedgerEntries` covers every prune the sweep made).
 */
export class PostgresLedgerMarkMissingError extends AGBossError {
  static override readonly code = "postgres.ledger-mark-missing" as const;
  declare readonly code: typeof PostgresLedgerMarkMissingError.code;
  override name = "PostgresLedgerMarkMissingError";

  constructor(options: PostgresLedgerMarkMissingErrorOptions = {}) {
    super(
      "the ledger's pruning mark is missing (agboss_cost_entries_pruned has no row): nothing was added — insert it with a mark no lower than any prune's cutoff, e.g. INSERT INTO agboss_cost_entries_pruned VALUES (true, now())",
      { cause: options.cause },
    );
  }
}

/** What a failed index step takes: what the run did before it, and why the step failed. */
export interface PostgresStepIndexErrorOptions {
  /** The numbered migrations and LangGraph's setup the run committed before the index step. */
  readonly report: MigrationReport;
  readonly cause: unknown;
  /**
   * An INVALID index the failed step could not drop (a transaction holding a lock on `checkpoints`
   * did not end within the bound, agbossjs/agboss#1116) stays: the message says the next run drops
   * and rebuilds it. Default false.
   */
  readonly invalidIndexLeft?: boolean;
}

/**
 * The migrations of a `migratePostgres` run are applied and committed, but its last step, the build of
 * the checkpoint index `checkpoints_latest_by_step` (agbossjs/agboss#962), failed: the build was
 * cancelled, or the role does not own `checkpoints`. The schema IS migrated (`report` lists what
 * this run applied) and every read answers correctly, `latestByStep` slower. An INVALID index the
 * failed build left is dropped when that is quick (the drop gives up after a few seconds on a
 * transaction that holds a lock on `checkpoints`, #1116, and `invalidIndexLeft` says so); the next
 * `migrate` drops it then, and builds the index again. A script tells "schema not migrated" (any other error) from "index not
 * built" (this one).
 */
export class PostgresStepIndexError extends AGBossError {
  static override readonly code = "postgres.step-index-failed" as const;
  declare readonly code: typeof PostgresStepIndexError.code;
  override name = "PostgresStepIndexError";
  /** What the run committed before the index step failed. */
  readonly report: MigrationReport;
  /** Whether an INVALID index stays for the next run to drop (see the options). */
  readonly invalidIndexLeft: boolean;

  constructor(options: PostgresStepIndexErrorOptions) {
    const reason = options.cause instanceof Error ? options.cause.message : String(options.cause);
    const next =
      options.invalidIndexLeft === true
        ? "an INVALID index checkpoints_latest_by_step stays: the next migrate run drops and rebuilds it"
        : "the next migrate run rebuilds the index (an INVALID one is dropped first)";
    super(
      `index checkpoints_latest_by_step (${options.report.schema}) failed: ${reason}; the migrations are applied and reads stay correct; ${next}`,
      { cause: options.cause },
    );
    this.report = options.report;
    this.invalidIndexLeft = options.invalidIndexLeft === true;
  }
}
