import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { z } from "zod";
import { migrationsIn, newestVersionOf, type MigrationFile } from "./files.js";
import {
  appliedMigrationsOf,
  HISTORY_TABLE,
  isUndefinedTable,
  pendingMigrations,
} from "./history.js";
import { inTransaction } from "../connection/transaction.js";
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
}

/**
 * The key of the advisory lock every run takes (with the schema's hash as its second half): of two
 * runs on one schema one waits for the other, then finds nothing left to apply.
 */
export const MIGRATION_LOCK_KEY = 0x41474253;

const SchemaRow = z.object({ schema: z.string().nullable() });
const VersionRow = z.object({ newest: z.number().nullable() });

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

/** `migratePostgres` with the migrations given (a test's folder). */
export async function migrateWith(
  options: MigratePostgresOptions,
  files: readonly MigrationFile[],
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
  });
  try {
    const client = await pool.connect();
    // a dropped session rejects its statement in flight; the pool is ended below either way
    const onLost = (): undefined => undefined;
    client.on("error", onLost);
    try {
      if (schema !== undefined) await createSchema(client, schema);
      const run = { pool, client, files, schema, signal: options.signal };
      return await underLock(client, () => migrateLocked(run));
    } finally {
      client.off("error", onLost);
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** PostgreSQL's codes when a concurrent `CREATE SCHEMA IF NOT EXISTS` made it first. */
const SCHEMA_RACE_CODES: ReadonlySet<unknown> = new Set(["23505", "42P06"]);

/** `schema` made unless it exists — another run creating it at the same moment is fine. */
async function createSchema(client: pg.PoolClient, schema: string): Promise<void> {
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
  let result: TResult;
  try {
    result = await work();
  } catch (error) {
    // the work's error is the run's: an unlock that fails too changes nothing (the session ends)
    await client
      .query("SELECT pg_advisory_unlock($1, hashtext(current_schema()))", [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    throw error;
  }
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
  const pending = pendingMigrations(files, await appliedMigrationsOf(client));
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

/** LangGraph's checkpoint tables in `schema`, set up by its saver; how many of its migrations ran. */
async function setupCheckpoints(
  pool: pg.Pool,
  client: pg.PoolClient,
  schema: string,
): Promise<number> {
  const before = await checkpointVersionOf(client);
  await new PostgresSaver(pool, undefined, { schema }).setup();
  return (await checkpointVersionOf(client)) - before;
}

/** The newest of LangGraph's checkpoint migrations applied (-1: none, its table absent). */
async function checkpointVersionOf(client: pg.PoolClient): Promise<number> {
  try {
    const { rows } = await client.query("SELECT max(v) AS newest FROM checkpoint_migrations");
    return VersionRow.parse(rows[0]).newest ?? -1;
  } catch (error) {
    if (isUndefinedTable(error)) return -1;
    throw error;
  }
}
