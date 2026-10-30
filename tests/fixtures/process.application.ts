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
import { usd, type Usd } from "@agboss/core/units";
import {
  PostgresCheckpointSaver,
  PostgresChildExecutionQueueRepository,
  PostgresExecutionLeaseEventRepository,
  PostgresExecutionLeaseRepository,
  PostgresExecutionRecordRepository,
  PostgresExecutionTreeRepository,
  PostgresFencedEffectRepository,
  PostgresPausedExecutionRepository,
} from "../../src/index.js";
import {
  ApprovalWorkflow,
  OfflineClerkModelProvider,
  QueuedShipApprovalChannel,
} from "./approval.workflow.js";
import { BatchWorkflow, ItemWorkflow } from "./batch.workflow.js";
import { ProcessEnvironment } from "./environments/app.environment.js";
import { emit } from "./process-log.js";
import { TakeoverWorkflow } from "./takeover.workflow.js";

/**
 * The application each process of tests/processes/ runs (`environments/process.environment.ts`):
 * every coordination store on PostgreSQL — nothing on a disk, nothing shared but the database —
 * and one step slot per instance (`maxConcurrentSteps: 1`), so a launch of several children needs
 * both instances. Its observer tells the test of every end and every takeover.
 */

@Budget({
  name: "process-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class ProcessApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
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
  workflows: [TakeoverWorkflow, BatchWorkflow, ItemWorkflow, ApprovalWorkflow],
  observers: [ProcessObserver],
  budgets: [ProcessApplicationBudget, ProcessTenantBudget, ProcessExecutionBudget],
  maxConcurrentSteps: 1,
  providers: [
    OfflineClerkModelProvider,
    QueuedShipApprovalChannel,
    PostgresCheckpointSaver,
    PostgresChildExecutionQueueRepository,
    PostgresExecutionLeaseEventRepository,
    PostgresExecutionLeaseRepository,
    PostgresExecutionRecordRepository,
    PostgresExecutionTreeRepository,
    PostgresFencedEffectRepository,
    PostgresPausedExecutionRepository,
  ],
})
export class ProcessApplication {}

// `agboss check` types the workflows the application module exports (.agboss/types.d.ts)
export { ApprovalWorkflow, BatchWorkflow, ItemWorkflow, TakeoverWorkflow };
