import {
  Action,
  ApplicationContext,
  ChildPlacement,
  ExecutionContext,
  listOf,
  start,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "@agboss/core";
import { DoneDto, JobDto, SummaryDto } from "./dto.js";
import { atGate, emit } from "./process-log.js";

/**
 * AC2 — a batch: one `item-workflow` child per job, queued with `ChildPlacement.AnyInstance` in
 * the PostgreSQL child queue. A child's step tells where it ran, then waits at its process's gate,
 * so with one step slot per instance a claimed child keeps its instance busy until the test opens
 * the gates.
 */

@Action({
  name: "item-action",
  description: "Does one job and says where",
  input: { job: JobDto },
  output: DoneDto,
  deps: [ApplicationContext, ExecutionContext],
})
export class ItemAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: { readonly job: Produced<JobDto, unknown> }): Promise<DoneDto> {
    const { name } = input.job.value;
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
  flow: [
    start(ItemWorkflowStart)
      .returns(JobDto)
      .toAction(ItemAction)
      .returns(DoneDto)
      .toFinish(ItemWorkflowFinish),
  ],
})
export class ItemWorkflow {}

@WorkflowStart({ name: "batch-workflow-start", description: "The jobs", input: listOf(JobDto) })
export class BatchWorkflowStart {}

@WorkflowFinish({
  name: "batch-workflow-finish",
  description: "Every job, done",
  input: { results: listOf(DoneDto) },
  output: SummaryDto,
})
export class BatchWorkflowFinish {
  finish(input: { readonly results: readonly Produced<DoneDto, unknown>[] }): SummaryDto {
    return { text: input.results.map((result) => result.value.name).join(", ") };
  }
}

@Workflow({
  name: "batch-workflow",
  version: "1.0.0",
  flow: [
    start(BatchWorkflowStart)
      .returns(listOf(JobDto))
      .toParallelWorkflows(ItemWorkflow, {
        maxConcurrency: 6,
        maxItems: 10,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(DoneDto))
      .toFinish(BatchWorkflowFinish),
  ],
})
export class BatchWorkflow {}
