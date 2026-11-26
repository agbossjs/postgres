import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  DatabaseStorage,
  env,
  Mesh,
  MeshInboundMode,
  Observer,
  secret,
  type BudgetHandler,
  type ExecutionEndEvent,
  type ExecutionLeaseTakeoverEvent,
  type ExecutionObserver,
} from "@agboss/core";
import { hours, minutes, usd, type Usd } from "@agboss/core/units";
import {
  ApprovalWorkflow,
  OfflineClerkModelProvider,
  QueuedShipApprovalChannel,
  TwoApprovalsWorkflow,
} from "./approval.workflow.js";
import { BatchWorkflow, ItemWorkflow } from "./batch.workflow.js";
import { ChargeWorkflow, OrderChargeWorkflow } from "./charge.workflow.js";
import { HeldPostgresDriver } from "./held-stores.js";
import { emit } from "./process-log.js";
import {
  LimitedModelProvider,
  LimitedWorkflow,
  OrdersAuthenticator,
  PricedModelProvider,
  ProcessA2AEndpoint,
  SpendExecutionBudget,
  SpendWorkflow,
} from "./shared.workflow.js";
import { PaidHoldWorkflow } from "./paid-hold.workflow.js";
import { PayItemsWorkflow, PayItemWorkflow } from "./spend-in-flight.workflow.js";
import { StopBatchWorkflow, StopItemWorkflow } from "./stop/stop.application.js";
import { TakeoverWorkflow } from "./takeover.workflow.js";

/**
 * The application each process of tests/processes/ runs: every store on PostgreSQL through its
 * `@DatabaseStorage` (`PostgresDriver`), the outbound calls' too (agbossjs/agboss#505) — nothing on a
 * disk, nothing shared but the database — and one step slot per instance
 * (`executionLimits.maxConcurrentSteps: 1`), so a launch of several children needs both instances; the
 * driver's lease store is the package's with the test's hold on an acquire (agbossjs/agboss#520).
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
@Observer()
export class ProcessObserver implements ExecutionObserver {
  onExecutionEnd(event: ExecutionEndEvent): void {
    const { executionId, rootExecutionId, parentExecutionId, tenantId, finish } = event;
    emit("end", { executionId, rootExecutionId, parentExecutionId, tenantId, finish: finish.name });
  }

  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): void {
    emit("takeover", { ...event });
  }
}

/** Every row on PostgreSQL: the test's schema, a pool of 4, the keys the processes share. */
@DatabaseStorage({
  name: "process-database-storage",
  description: "The process tests' PostgreSQL, the lease store held",
  driver: HeldPostgresDriver({ url: secret("AGBOSS_PROCESS_DATABASE_URL"), poolSize: 4 }),
  auditLogTtl: hours(24),
  ledgerEntriesTtl: hours(24),
  // every process of a test keys its business-key fingerprints alike (agbossjs/agboss#825)
  idempotencySecret: secret("AGBOSS_PROCESS_IDEMPOTENCY_KEY"),
})
export class ProcessDatabaseStorage {}

/** The mesh peer `orders-application` is trusted (AC4): its public key is the harness's pair's. */
@Mesh({
  name: "process-mesh",
  description: "Trusts the orders application",
  inboundMode: MeshInboundMode.AllowExternal,
  deduplicationTtl: minutes(30),
  maxHops: 4,
  peers: [{ application: "orders-application", verifyKeys: [env("AGBOSS_PROCESS_MESH_PEER_KEY")] }],
})
export class ProcessMesh {}

@Application({
  name: "postgres-process-application",
  version: "1.0.0",
  storage: ProcessDatabaseStorage,
  workflows: [
    TakeoverWorkflow,
    BatchWorkflow,
    ItemWorkflow,
    ApprovalWorkflow,
    TwoApprovalsWorkflow,
    SpendWorkflow,
    LimitedWorkflow,
    ChargeWorkflow,
    OrderChargeWorkflow,
    PaidHoldWorkflow,
    PayItemsWorkflow,
    PayItemWorkflow,
  ],
  observers: [ProcessObserver],
  budgets: [
    ProcessApplicationBudget,
    ProcessTenantBudget,
    ProcessExecutionBudget,
    SpendExecutionBudget,
  ],
  executionLimits: { maxConcurrentSteps: 1 },
  retention: { executionRecords: hours(24) },
  endpoints: [ProcessA2AEndpoint],
  mesh: ProcessMesh,
  providers: [
    OfflineClerkModelProvider,
    PricedModelProvider,
    LimitedModelProvider,
    QueuedShipApprovalChannel,
    OrdersAuthenticator,
  ],
})
export class ProcessApplication {}

// `agboss check` types the workflows the application module exports (.agboss/types.d.ts)
export {
  ApprovalWorkflow,
  TwoApprovalsWorkflow,
  BatchWorkflow,
  ChargeWorkflow,
  OrderChargeWorkflow,
  ItemWorkflow,
  LimitedWorkflow,
  PaidHoldWorkflow,
  PayItemsWorkflow,
  PayItemWorkflow,
  SpendWorkflow,
  StopBatchWorkflow,
  StopItemWorkflow,
  TakeoverWorkflow,
};
