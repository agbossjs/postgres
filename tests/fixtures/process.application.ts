import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  Injectable,
  type BudgetHandler,
  type ExecutionEndEvent,
  type ExecutionLeaseTakeoverEvent,
  type OnExecutionEnd,
  type OnExecutionLeaseTakeover,
} from "@agboss/core";
import { hours, usd, type Usd } from "@agboss/core/units";
import {
  PostgresConnection,
  PostgresCheckpointSaver,
  PostgresChildExecutionQueueRepository,
  PostgresCostLedgerRepository,
  PostgresExecutionHistoryRepository,
  PostgresExecutionLeaseEventRepository,
  PostgresExecutionRecordRepository,
  PostgresExecutionTreeRepository,
  PostgresFencedEffectRepository,
  PostgresMeshRequestRepository,
  PostgresOutboundCallRepository,
  PostgresPausedExecutionRepository,
  PostgresRateLimitRepository,
} from "../../src/index.js";
import {
  ApprovalWorkflow,
  OfflineClerkModelProvider,
  QueuedShipApprovalChannel,
} from "./approval.workflow.js";
import { BatchWorkflow, ItemWorkflow } from "./batch.workflow.js";
import { ChargeWorkflow, OrderChargeWorkflow } from "./charge.workflow.js";
import { HeldPostgresExecutionLeaseRepository } from "./held-stores.js";
import { ProcessEnvironment } from "./environments/app.environment.js";
import { emit } from "./process-log.js";
import {
  LimitedModelProvider,
  LimitedWorkflow,
  PricedModelProvider,
  ProcessA2AExpose,
  SpendExecutionBudget,
  SpendWorkflow,
} from "./shared.workflow.js";
import { TakeoverWorkflow } from "./takeover.workflow.js";

/**
 * The application each process of tests/processes/ runs (`environments/process.environment.ts`):
 * every store on PostgreSQL, the outbound calls' too (agbossjs/agboss#505) — nothing on a disk, nothing shared but the database — and one step
 * slot per instance (`maxConcurrentSteps: 1`), so a launch of several children needs both
 * instances; its lease store is the package's with the test's hold on an acquire (agbossjs/agboss#520).
 * It keeps its executions' history (agbossjs/agboss#483 AC3), trusts the mesh peer
 * `orders-application` (AC4), and its tenant's day is $10 (AC1). Its observer tells the test of
 * every end and every takeover.
 */

@Budget({
  name: "process-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class ProcessApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(100);
  }
}

@Budget({ name: "process-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class ProcessTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
  }
}

@Budget({ name: "process-execution-budget", scope: BudgetScope.Execution })
export class ProcessExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

/** Tells the test of each execution's end and each takeover of a lease. */
@Injectable()
export class ProcessObserver implements OnExecutionEnd, OnExecutionLeaseTakeover {
  onExecutionEnd(event: ExecutionEndEvent): void {
    const { executionId, rootExecutionId, parentExecutionId, tenantId, finish } = event;
    emit("end", { executionId, rootExecutionId, parentExecutionId, tenantId, finish: finish.name });
  }

  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): void {
    emit("takeover", { ...event });
  }
}

@Application({
  name: "postgres-process-application",
  version: "1.0.0",
  environment: ProcessEnvironment,
  workflows: [
    TakeoverWorkflow,
    BatchWorkflow,
    ItemWorkflow,
    ApprovalWorkflow,
    SpendWorkflow,
    LimitedWorkflow,
    ChargeWorkflow,
    OrderChargeWorkflow,
  ],
  observers: [ProcessObserver],
  budgets: [
    ProcessApplicationBudget,
    ProcessTenantBudget,
    ProcessExecutionBudget,
    SpendExecutionBudget,
  ],
  maxConcurrentSteps: 1,
  executionRecordRetention: hours(24),
  exposes: [ProcessA2AExpose],
  mesh: { peers: [{ application: "orders-application", verifyKey: "meshPeerKey" }] },
  providers: [
    OfflineClerkModelProvider,
    PricedModelProvider,
    LimitedModelProvider,
    QueuedShipApprovalChannel,
    PostgresConnection,
    PostgresCheckpointSaver,
    PostgresChildExecutionQueueRepository,
    PostgresCostLedgerRepository,
    PostgresExecutionHistoryRepository,
    PostgresExecutionLeaseEventRepository,
    HeldPostgresExecutionLeaseRepository,
    PostgresExecutionRecordRepository,
    PostgresExecutionTreeRepository,
    PostgresFencedEffectRepository,
    PostgresMeshRequestRepository,
    PostgresOutboundCallRepository,
    PostgresPausedExecutionRepository,
    PostgresRateLimitRepository,
  ],
})
export class ProcessApplication {}

// `agboss check` types the workflows the application module exports (.agboss/types.d.ts)
export {
  ApprovalWorkflow,
  BatchWorkflow,
  ChargeWorkflow,
  OrderChargeWorkflow,
  ItemWorkflow,
  LimitedWorkflow,
  SpendWorkflow,
  TakeoverWorkflow,
};
