/**
 * `@agboss/postgres` (#482, #483): AGBoss's stores on PostgreSQL — several application instances,
 * each its own process with no shared disk, share execution trees, budgets, history, rate limits
 * and mesh requests on one database: a whole application on PostgreSQL alone.
 * List the stores in `@Application({ providers })`; the environment gives `postgresUrl` (a
 * `Secret`), optionally `postgresPoolSize` and `postgresMigrateOnStart`. The schema is migrated
 * explicitly: `agboss-postgres migrate --url <url>` (a Kubernetes Job), or `migratePostgres({ url })`.
 */
export { PostgresConnection } from "./connection/postgres-connection.js";
export type { PostgresConnectionSettings } from "./connection/settings.js";
export { PostgresExecutionLeaseRepository } from "./stores/postgres-execution-lease.repository.js";
export { PostgresExecutionTreeRepository } from "./stores/postgres-execution-tree.repository.js";
export {
  migratePostgres,
  type AppliedMigrationReport,
  type MigratePostgresOptions,
  type MigrationReport,
} from "./migrations/migrate.js";
export {
  PostgresMigrationChangedError,
  PostgresSchemaMissingError,
  PostgresSchemaTooNewError,
  PostgresSettingsError,
  type ChangedMigration,
  type SchemaVersions,
} from "./errors.js";
export { PostgresExecutionRecordRepository } from "./stores/postgres-execution-record.repository.js";
export { PostgresPausedExecutionRepository } from "./stores/postgres-paused-execution.repository.js";
export { PostgresChildExecutionQueueRepository } from "./stores/postgres-child-execution-queue.repository.js";
export { PostgresCheckpointSaver } from "./stores/postgres-checkpoint-saver.js";
export { PostgresFencedEffectRepository } from "./stores/postgres-fenced-effect.repository.js";
export { PostgresExecutionLeaseEventRepository } from "./stores/postgres-execution-lease-event.repository.js";
export { PostgresCostLedgerRepository } from "./stores/postgres-cost-ledger.repository.js";
export { PostgresExecutionHistoryRepository } from "./stores/postgres-execution-history.repository.js";
export { PostgresRateLimitRepository } from "./stores/postgres-rate-limit.repository.js";
export { PostgresMeshRequestRepository } from "./stores/postgres-mesh-request.repository.js";
export { PostgresOutboundCallRepository } from "./stores/postgres-outbound-call.repository.js";
