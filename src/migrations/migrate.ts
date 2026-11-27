import pg from "pg";
import { z } from "zod";
import { migrationsIn, newestVersionOf, type MigrationFile } from "./files.js";
import { appliedMigrationsOf, HISTORY_TABLE, pendingMigrations } from "./history.js";
import { StepIndexFailure, stepIndexAfter, type StepIndexResult } from "./checkpoint-step-index.js";
import { PostgresStepIndexError } from "../errors.js";
import { refuseLiveLeases } from "./live-leases.js";
import { setupCheckpoints } from "./checkpoint-setup.js";
import { inTransaction } from "../connection/transaction.js";
import { onConnectOf } from "../connection/utc-session.js";
import { checkedSchemaOf, quotedIdentifier, searchPathOptionOf } from "../connection/settings.js";
import { connectTimeoutOf } from "../connection/connect-timeout.js";

/**
 * What `migratePostgres` takes: the database, the schema, and a signal that stops the run between
 * migrations.
 */
export interface MigratePostgresOptions {
  /** `postgres://user:password@host:5432/database`. */
  readonly url: string;
  /**
   * The schema to migrate (agbossjs/agboss#891), created when missing — the application's
   * `postgresSchema`. Unset → the URL's `search_path` (`DEFAULT_SCHEMA` by default), which must exist.
   */
  readonly schema?: string;
  /** Aborted → the run stops before its next migration (one already begun commits or rolls back). */
  readonly signal?: AbortSignal;
  /**
   * Migrate although an execution lease is live (agbossjs/agboss#1104). Unset → a run that would
   * apply a migration to a database already migrated refuses (`PostgresLiveLeasesError`): a schema
   * upgrade is stop the old instances → migrate → deploy.
   */
  readonly allowLiveLeases?: boolean;
}

/**
 * What `migrateWith` takes: `MigratePostgresOptions`, its schema possibly unset by name (the start
 * check passes the connection's, which may be unset).
 */
export interface MigrationRunOptions extends Omit<MigratePostgresOptions, "schema"> {
  readonly schema?: string | undefined;
}

/** One migration a run applied. */
export interface AppliedMigrationReport {
  readonly version: number;
  readonly name: string;
}

/** What one run did: a second run on the same database reports `applied: []`. */
export interface MigrationReport {
  /** The schema migrated: `schema`, else the first existing one of the URL's `search_path`. */
  readonly schema: string;
  /** The package's migrations this run applied, in order. */
  readonly applied: readonly AppliedMigrationReport[];
  /** The newest migration applied to the database now. */
  readonly version: number;
  /** How many of LangGraph's own checkpoint migrations (`PostgresSaver.setup()`) this run applied. */
  readonly checkpointMigrations: number;
  /**
   * What the run did to the checkpoint index `checkpoints_latest_by_step` (agbossjs/agboss#962):
   * `built` it, found it `present` (valid), or `skipped` it because another run holds its build's
   * lock. Unset when the run did not wait for the index (a start that migrates builds it in the
   * background).
   */
  readonly stepIndex?: StepIndexResult;
}

/**
 * The key of the advisory lock every run takes (with the schema's hash as its second half): of two
 * runs on one schema one waits for the other, then finds nothing left to apply.
 */
export const MIGRATION_LOCK_KEY = 0x41474253;

const SchemaRow = z.object({ schema: z.string().nullable() });

/**
 * Applies this package's migrations (`migrations/NNNN_<name>.sql`) not yet applied to the
 * database, each in its own transaction, then LangGraph's checkpoint tables
 * (`PostgresSaver.setup()`), all under one advisory lock — so concurrent runs serialize, and a run
 * after them applies nothing. An applied migration whose file changed fails the run before
 * anything is applied (`PostgresMigrationChangedError`); a database a newer package migrated fails
 * it too (`PostgresSchemaTooNewError`). The command `agboss-postgres migrate` runs it.
 */
export function migratePostgres(options: MigratePostgresOptions): Promise<MigrationReport> {
  return migrateWith(options, migrationsIn());
}

/**
 * `migratePostgres` with the migrations given (a test's folder). After them, the migration lock
 * released, the checkpoint index is built (`buildStepIndex`, agbossjs/agboss#962): awaited — a
 * command is done when its index is —, or `indexInBackground` (a start that migrates: the pod
 * serves while it builds; a failed build is a slower read, the next run builds it).
 */
export async function migrateWith(
  options: MigrationRunOptions,
  files: readonly MigrationFile[],
  indexInBackground = false,
): Promise<MigrationReport> {
  options.signal?.throwIfAborted();
  const schema = checkedSchemaOf(options.schema);
  // two connections: the lock's session, and the one LangGraph's setup takes from the pool — both
  // in `schema` (its search_path) when one is given
  const pool = new pg.Pool({
    connectionString: options.url,
    max: 2,
    // agbossjs/agboss#989: a database that never answers the start fails the run, never hangs it
    connectionTimeoutMillis: connectTimeoutOf(options.url),
    ...(schema === undefined ? {} : { options: searchPathOptionOf(schema) }),
    onConnect: onConnectOf(schema),
  });
  try {
    const client = await pool.connect();
    // a dropped session rejects its statement in flight (and emits "error", which would throw with
    // no listener); the pool, and the listener with it, is ended below either way
    client.on("error", () => undefined);
    try {
      if (schema !== undefined) await createSchema(client, schema);
      const run = {
        pool,
        client,
        files,
        schema,
        signal: options.signal,
        allowLiveLeases: options.allowLiveLeases,
      };
      const report = await underLock(client, () => migrateLocked(run));
      const stepIndex = await stepIndexAfter(options, report.schema, indexInBackground).catch(
        (failure: unknown) => {
          // the migrations are committed: say so, with what this run applied (agbossjs/agboss#1102)
          throw failure instanceof StepIndexFailure
            ? new PostgresStepIndexError({
                report,
                cause: failure.cause,
                invalidIndexLeft: failure.invalidIndexLeft,
              })
            : new PostgresStepIndexError({ report, cause: failure });
        },
      );
      return stepIndex === undefined ? report : { ...report, stepIndex };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * PostgreSQL's codes when a concurrent `CREATE SCHEMA IF NOT EXISTS` made it first: `unique_violation`
 * when the other's insert was not committed yet at the existence check, `duplicate_schema` when it
 * committed between that check and the insert.
 */
const SCHEMA_RACE_CODES: ReadonlySet<unknown> = new Set(["23505", "42P06"]);

/** What `createSchema` needs of a session. */
export interface SchemaStatements {
  query(sql: string): Promise<unknown>;
}

/** `schema` made unless it exists — another run creating it at the same moment is fine. */
export async function createSchema(client: SchemaStatements, schema: string): Promise<void> {
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedIdentifier(schema)}`);
  } catch (error) {
    if (!(error instanceof Error && SCHEMA_RACE_CODES.has(Reflect.get(error, "code")))) throw error;
  }
}

/** `work` while this session holds the schema's migration lock. */
async function underLock<TResult>(
  client: pg.PoolClient,
  work: () => Promise<TResult>,
): Promise<TResult> {
  await client.query("SELECT pg_advisory_lock($1, hashtext(current_schema()))", [
    MIGRATION_LOCK_KEY,
  ]);
  // a failed run keeps the lock until its session ends, right after (the run's pool is ended)
  const result = await work();
  // released before the index step: its build waits for every transaction, a waiter's among them
  await client.query("SELECT pg_advisory_unlock($1, hashtext(current_schema()))", [
    MIGRATION_LOCK_KEY,
  ]);
  return result;
}

/** One run: its pool and lock session, the files, the schema it was given, its signal. */
interface MigrationRun {
  readonly pool: pg.Pool;
  readonly client: pg.PoolClient;
  readonly files: readonly MigrationFile[];
  readonly schema: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly allowLiveLeases: boolean | undefined;
}

async function migrateLocked(run: MigrationRun): Promise<MigrationReport> {
  const { pool, client, files, signal } = run;
  signal?.throwIfAborted();
  const schema = await currentSchemaOf(client);
  // the file's statements run in the schema whatever they set themselves (#891): the files are
  // unchanged, so their checksums are
  const setSearchPath =
    run.schema === undefined
      ? undefined
      : `SET LOCAL search_path TO ${quotedIdentifier(run.schema)}`;
  await client.query(HISTORY_TABLE);
  const done = await appliedMigrationsOf(client);
  const pending = pendingMigrations(files, done);
  // a database migrated before (a newest applied migration) is an upgrade: its leases are guarded
  const newest = done.at(-1);
  if (pending.length > 0 && newest !== undefined && run.allowLiveLeases !== true)
    await refuseLiveLeases(client);
  const applied: AppliedMigrationReport[] = [];
  for (const file of pending) {
    signal?.throwIfAborted();
    await inTransaction(client, async () => {
      if (setSearchPath !== undefined) await client.query(setSearchPath);
      await client.query(file.sql);
      await client.query(
        "INSERT INTO agboss_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [file.version, file.name, file.checksum],
      );
    });
    applied.push({ version: file.version, name: file.name });
  }
  const checkpointMigrations = await setupCheckpoints(pool, client, schema);
  return { schema, applied, version: newestVersionOf(files), checkpointMigrations };
}

/** The schema the connection creates its tables in; none (an empty `search_path`) fails the run. */
async function currentSchemaOf(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query("SELECT current_schema() AS schema");
  const { schema } = SchemaRow.parse(rows[0]);
  if (schema === null)
    throw new Error("the connection's search_path names no existing schema: create it first");
  return schema;
}
