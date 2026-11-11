import { PostgresA2ATaskRepository } from "./stores/postgres-a2a-task.repository.js";
import { PostgresCheckpointSaver } from "./stores/postgres-checkpoint-saver.js";
import { PostgresChildExecutionQueueRepository } from "./stores/postgres-child-execution-queue.repository.js";
import { PostgresCostLedgerRepository } from "./stores/postgres-cost-ledger.repository.js";
import { PostgresExecutionAuditLogRepository } from "./stores/postgres-execution-audit-log.repository.js";
import { PostgresExecutionHistoryRepository } from "./stores/postgres-execution-history.repository.js";
import { PostgresExecutionLeaseRepository } from "./stores/postgres-execution-lease.repository.js";
import { PostgresExecutionRecordRepository } from "./stores/postgres-execution-record.repository.js";
import { PostgresExecutionTreeRepository } from "./stores/postgres-execution-tree.repository.js";
import { PostgresFencedEffectRepository } from "./stores/postgres-fenced-effect.repository.js";
import { PostgresMeshRequestRepository } from "./stores/postgres-mesh-request.repository.js";
import { PostgresOutboundCallRepository } from "./stores/postgres-outbound-call.repository.js";
import { PostgresPausedExecutionRepository } from "./stores/postgres-paused-execution.repository.js";
import { PostgresRateLimitRepository } from "./stores/postgres-rate-limit.repository.js";

/**
 * The PostgreSQL stores that keep durable rows and need no lease check of their own
 * (agbossjs/agboss#891): every store of the package but the coordination ones (leases, the child
 * queue, rate limits) and the two that check the lease in their own transaction (fenced effects,
 * outbound calls). Spread it beside `REDIS_COORDINATION_STORES` and
 * `provide(EXECUTION_ID_STORE, PostgresExecutionLeaseRepository)`:
 * `providers: [...POSTGRES_DURABLE_STORES, ...REDIS_COORDINATION_STORES, provide(…)]`.
 */
export const POSTGRES_DURABLE_STORES = [
  PostgresExecutionTreeRepository,
  PostgresExecutionRecordRepository,
  PostgresPausedExecutionRepository,
  PostgresCheckpointSaver,
  PostgresExecutionAuditLogRepository,
  PostgresCostLedgerRepository,
  PostgresExecutionHistoryRepository,
  PostgresMeshRequestRepository,
  PostgresA2ATaskRepository,
] as const;

/**
 * Every store of the package (agbossjs/agboss#891): a whole application on PostgreSQL alone —
 * `@Application({ providers: [...POSTGRES_STORES] })`. `agboss describe` still names each one.
 */
export const POSTGRES_STORES = [
  PostgresExecutionLeaseRepository,
  PostgresChildExecutionQueueRepository,
  PostgresRateLimitRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
  ...POSTGRES_DURABLE_STORES,
] as const;
