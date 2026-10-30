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

/** What `migratePostgres` takes: the database, and a signal that stops the run between migrations. */
export interface MigratePostgresOptions {
  /** `postgres://user:password@host:5432/database` (its `search_path` names the schema). */
  readonly url: string;
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
  /** The schema migrated: the first existing one of the connection's `search_path`. */
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
  // two connections: the lock's session, and the one LangGraph's setup takes from the pool
  const pool = new pg.Pool({ connectionString: options.url, max: 2 });
  try {
    const client = await pool.connect();
    // a dropped session rejects its statement in flight; the pool is ended below either way
    const onLost = (): undefined => undefined;
    client.on("error", onLost);
    try {
      return await underLock(client, () => migrateLocked(pool, client, files, options.signal));
    } finally {
      client.off("error", onLost);
      client.release();
    }
  } finally {
    await pool.end();
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

async function migrateLocked(
  pool: pg.Pool,
  client: pg.PoolClient,
  files: readonly MigrationFile[],
  signal: AbortSignal | undefined,
): Promise<MigrationReport> {
  signal?.throwIfAborted();
  const schema = await currentSchemaOf(client);
  await client.query(HISTORY_TABLE);
  const pending = pendingMigrations(files, await appliedMigrationsOf(client));
  const applied: AppliedMigrationReport[] = [];
  for (const file of pending) {
    signal?.throwIfAborted();
    await inTransaction(client, async () => {
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
