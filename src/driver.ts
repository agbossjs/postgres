import {
  defineStorageDriver,
  StorageRole,
  type DatabaseDriver,
  type DriverTimeouts,
  type ResolvedSettings,
  type SchemaSetup,
  type StorageMigration,
  type StorageMigrationOptions,
} from "@agboss/core/stores";
import type { EnvRef, SecretRef } from "@agboss/core";
import { PostgresConnection } from "./connection/postgres-connection.js";
import { settingsOfResolved, timeoutSettingsOf } from "./connection/driver-settings.js";
import { migratePostgres } from "./migrations/migrate.js";
import { POSTGRES_STORES } from "./store-bundles.js";
import { PostgresChildExecutionQueueRepository } from "./stores/postgres-child-execution-queue.repository.js";
import { PostgresExecutionLeaseRepository } from "./stores/postgres-execution-lease.repository.js";
import { PostgresRateLimitRepository } from "./stores/postgres-rate-limit.repository.js";

/** `PostgresDriver({ url })` options (agbossjs/agboss#1321). */
export interface PostgresDriverOptions {
  /** The database: `secret("POSTGRES_URL")`, read once when the application starts, never printed. */
  readonly url: SecretRef;
  /**
   * The schema of the stores' tables: two applications on one database, each in its own. A name, or
   * `env("POSTGRES_SCHEMA")` read once when the application starts, as the url is.
   */
  readonly schema?: string | EnvRef<string>;
  /** The most connections the instance's pool opens (default 10). */
  readonly poolSize?: number;
  /** What the start does with the schema (default `SchemaSetup.Check`: it is migrated by `agboss migrate db`). */
  readonly schemaSetup?: SchemaSetup;
  /** The time options, in `Milliseconds`: the watch's liveness, the command and idle-in-transaction timeouts. */
  readonly timeouts?: DriverTimeouts;
}

/**
 * `agboss migrate db` on the driver's settings, as resolved (agbossjs/agboss#1321f): the schema
 * brought to this version, refusing with `StoreError.LiveLeases` (`PostgresLiveLeasesError`) while a
 * lease is live unless the command says `--allow-live-leases`. The names of the migrations applied.
 */
export async function migrateWithDriver(
  resolved: ResolvedSettings,
  options: StorageMigrationOptions,
): Promise<StorageMigration> {
  const settings = settingsOfResolved(resolved);
  const report = await migratePostgres({
    url: settings.url,
    ...(settings.schema === undefined ? {} : { schema: settings.schema }),
    allowLiveLeases: options.allowLiveLeases,
  });
  return { applied: report.applied.map((migration) => migration.name) };
}

/** What the driver tells of itself: a schema named in the code by its name, one read from the environment by its variable. */
function describedOf(schema: string | EnvRef<string> | undefined): string {
  if (schema === undefined) return "postgres";
  return typeof schema === "string"
    ? `postgres (schema ${schema})`
    : `postgres (schema from ${schema.variable})`;
}

/**
 * The database on PostgreSQL (`@DatabaseStorage({ driver: PostgresDriver({ url: secret("POSTGRES_URL") }) })`):
 * every store of the package on the one pool of the instance — two instances open two pools to one
 * database. A `@ClusterStorage` takes the coordination stores' place; the lease store is the
 * application's durable one, where a cluster's lease keeps its ids and its marks.
 */
export function PostgresDriver(options: PostgresDriverOptions): DatabaseDriver {
  const { url, schema, poolSize, schemaSetup, timeouts } = options;
  return defineStorageDriver({
    role: StorageRole.Database,
    backend: "postgres",
    describes: describedOf(schema),
    settings: {
      kind: "postgres",
      url,
      ...(schema === undefined ? {} : { schema }),
      ...(poolSize === undefined ? {} : { poolSize }),
      ...(schemaSetup === undefined ? {} : { schemaSetup }),
      ...timeoutSettingsOf(timeouts),
    },
    providers: [PostgresConnection, ...POSTGRES_STORES],
    leaseStore: PostgresExecutionLeaseRepository,
    coordinationStores: [
      PostgresExecutionLeaseRepository,
      PostgresChildExecutionQueueRepository,
      PostgresRateLimitRepository,
    ],
    migrate: migrateWithDriver,
  });
}
