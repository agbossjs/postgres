import {
  Action,
  ApplicationContext,
  ChildPlacement,
  ExecutionContext,
  listOf,
  onStart,
  toWorkflow,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { DoneDto, JobDto, SummaryDto } from "./dto.js";
import { atGate, emit } from "./process-log.js";

/**
 * AC2 — a batch: one `item-workflow` child per job, queued in the PostgreSQL child queue because the
 * child's own `placement` is `ChildPlacement.AnyWorker`. A child's step tells where it ran, then
 * waits at its process's gate, so with one step slot per instance a claimed child keeps its
 * instance busy until the test opens the gates.
 */

@Action({
  name: "item-action",
  description: "Does one job and says where",
  input: { job: JobDto },
  output: DoneDto,
  deps: [ApplicationContext, ExecutionContext],
})
export class ItemAction implements ActionHandler<ItemAction> {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<ItemAction>): Promise<OutputOf<ItemAction>> {
    const { name } = input.job;
    const { instanceId } = this.applicationContext;
    const { executionId, root, tenant } = this.executionContext;
    const where = { executionId, rootExecutionId: root.executionId, tenantId: tenant.tenantId };
    emit("child-ran", { name, instanceId, ...where });
    await atGate(this.executionContext.signal);
    return { name, by: instanceId };
  }
}

@WorkflowStart({ name: "item-workflow-start", description: "One job", input: JobDto })
export class ItemWorkflowStart {}

@WorkflowFinish({ name: "item-workflow-finish", description: "The job, done", output: DoneDto })
export class ItemWorkflowFinish {}

@Workflow({
  name: "item-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  placement: ChildPlacement.AnyWorker,
  flow: [onStart(ItemWorkflowStart).toAction(ItemAction).toFinish(ItemWorkflowFinish)],
})
export class ItemWorkflow {}

@WorkflowStart({ name: "batch-workflow-start", description: "The jobs", input: listOf(JobDto) })
export class BatchWorkflowStart {}

@Action({
  name: "batch-summary-action",
  description: "Sums the jobs done up",
  input: { results: listOf(DoneDto) },
  output: SummaryDto,
})
export class BatchSummaryAction implements ActionHandler<BatchSummaryAction> {
  execute(input: InputOf<BatchSummaryAction>): Promise<OutputOf<BatchSummaryAction>> {
    return Promise.resolve({ text: input.results.map((result) => result.name).join(", ") });
  }
}

@WorkflowFinish({
  name: "batch-workflow-finish",
  description: "Every job, done",
  output: SummaryDto,
})
export class BatchWorkflowFinish {}

@Workflow({
  name: "batch-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(BatchWorkflowStart)
      .forEachItem(toWorkflow(ItemWorkflow), { takeFirst: 10, maxConcurrency: 6 })
      .join()
      .toAction(BatchSummaryAction)
      .toFinish(BatchWorkflowFinish),
  ],
})
export class BatchWorkflow {}
