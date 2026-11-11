import { AGBossError } from "@agboss/core";

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
  override name = "PostgresSchemaMissingError";
  readonly applied: number;
  readonly expected: number;

  constructor(versions: SchemaVersions) {
    super(
      `the PostgreSQL schema is at migration ${String(versions.applied)}, this package needs ${String(versions.expected)}: run \`${MIGRATE_COMMAND}\` with POSTGRES_URL set (add --schema <name> for the application's postgresSchema; or set postgresSchemaSetup: SchemaSetup.MigrateOnStart in the environment)`,
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
  override name = "PostgresSchemaTooNewError";
  readonly applied: number;
  readonly expected: number;

  constructor(versions: SchemaVersions) {
    super(
      `the PostgreSQL schema is at migration ${String(versions.applied)}, newer than this package's ${String(versions.expected)}: a newer @agboss/postgres migrated it — deploy that version, the migrations are not rolled back`,
    );
    this.applied = versions.applied;
    this.expected = versions.expected;
  }
}

/** Which migration changed after it was applied. */
export interface ChangedMigration {
  readonly version: number;
  readonly name: string;
}

/**
 * A migration applied to the database differs from the package's file of that version (its name
 * or its SHA-256): the files were edited after a release. Nothing is applied — restore the file;
 * a change of schema is a new migration.
 */
export class PostgresMigrationChangedError extends AGBossError {
  static override readonly code = "postgres.migration-changed" as const;
  override name = "PostgresMigrationChangedError";
  readonly version: number;
  readonly migration: string;

  constructor(changed: ChangedMigration) {
    super(
      `migration ${String(changed.version)} (${changed.name}) was applied with another name or checksum than this package's file: restore the file — a schema change is a new migration`,
    );
    this.version = changed.version;
    this.migration = changed.name;
  }
}

/**
 * The environment does not give what a PostgreSQL store needs: `postgresUrl` (a `Secret`), and
 * when set, `postgresPoolSize` (a whole number from 1), `postgresSchema` (a schema name: not empty,
 * no NUL, at most 63 bytes) and `postgresSchemaSetup` (a `SchemaSetup`).
 */
export class PostgresSettingsError extends AGBossError {
  static override readonly code = "postgres.settings-invalid" as const;
  override name = "PostgresSettingsError";
}

/**
 * The ledger's pruning mark (agbossjs/agboss#771, the one row of `agboss_cost_entries_pruned` that
 * migration 0023 seeds) is gone — deleted by hand: without it a save cannot tell an entry the ledger
 * pruned from a new one, so it adds nothing and fails. Put the row back with a mark no lower than
 * any prune's cutoff (`now − retention.costLedgerEntries` covers every prune the sweep made).
 */
export class PostgresLedgerMarkMissingError extends AGBossError {
  static override readonly code = "postgres.ledger-mark-missing" as const;
  override name = "PostgresLedgerMarkMissingError";

  constructor() {
    super(
      "the ledger's pruning mark is missing (agboss_cost_entries_pruned has no row): nothing was added — insert it with a mark no lower than any prune's cutoff, e.g. INSERT INTO agboss_cost_entries_pruned VALUES (true, now())",
    );
  }
}
