/**
 * `@agboss/postgres` (#482, #483): AGBoss's stores on PostgreSQL — several application instances,
 * each its own process with no shared disk, share execution trees, budgets, history, rate limits
 * and mesh requests on one database: a whole application on PostgreSQL alone.
 * List the stores in `@Application({ providers })` — all of them `...POSTGRES_STORES`; the
 * environment gives `postgresUrl` (a `Secret`), optionally `postgresPoolSize`, `postgresSchema` and
 * `postgresSchemaSetup`. The schema is migrated explicitly: `agboss-postgres migrate --url <url>
 * [--schema <name>]` (a Kubernetes Job), or `migratePostgres({ url, schema })`.
 */
export { PostgresConnection } from "./connection/postgres-connection.js";
export {
  DEFAULT_POOL_SIZE,
  DEFAULT_SCHEMA,
  type PostgresConnectionSettings,
} from "./connection/settings.js";
// what the start does with the schema (agbossjs/agboss#891): the core's, shared with @agboss/mongodb
export { SchemaSetup } from "@agboss/core/stores";
export { POSTGRES_DURABLE_STORES, POSTGRES_STORES } from "./store-bundles.js";
export { PostgresExecutionLeaseRepository } from "./stores/postgres-execution-lease.repository.js";
export { PostgresExecutionTreeRepository } from "./stores/postgres-execution-tree.repository.js";
export {
  migratePostgres,
  type AppliedMigrationReport,
  type MigratePostgresOptions,
  type MigrationReport,
} from "./migrations/migrate.js";
export {
  PostgresLedgerMarkMissingError,
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
export { PostgresExecutionAuditLogRepository } from "./stores/postgres-execution-audit-log.repository.js";
export { PostgresCostLedgerRepository } from "./stores/postgres-cost-ledger.repository.js";
export { PostgresExecutionHistoryRepository } from "./stores/postgres-execution-history.repository.js";
export { PostgresRateLimitRepository } from "./stores/postgres-rate-limit.repository.js";
export { PostgresMeshRequestRepository } from "./stores/postgres-mesh-request.repository.js";
export { PostgresOutboundCallRepository } from "./stores/postgres-outbound-call.repository.js";
export { PostgresA2ATaskRepository } from "./stores/postgres-a2a-task.repository.js";
export { PostgresA2ADirectMessageRepository } from "./stores/postgres-a2a-direct-message.repository.js";
