import {
  Action,
  ApplicationContext,
  ExecutionContext,
  start,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "@agboss/core";
import { DoneDto, JobDto } from "./dto.js";
import { atGate, emit } from "./process-log.js";

/**
 * AC1 — a workflow of two steps: `prepare` (told once per run: a checkpointed step is not repeated
 * on takeover) and `hold`, which waits at its process's gate — the step a process is killed in.
 */

/** Where a step ran: its process's instance and its place in the tree. */
const whereOf = (applicationContext: ApplicationContext, executionContext: ExecutionContext) => ({
  instanceId: applicationContext.instanceId,
  executionId: executionContext.executionId,
  rootExecutionId: executionContext.root.executionId,
  tenantId: executionContext.tenant.tenantId,
});

@Action({
  name: "prepare-action",
  description: "Prepares the job",
  input: { job: JobDto },
  output: JobDto,
  deps: [ApplicationContext, ExecutionContext],
})
export class PrepareAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
  ) {}

  execute(input: { readonly job: Produced<JobDto, unknown> }): Promise<JobDto> {
    const { name } = input.job.value;
    emit("prepared", { name, ...whereOf(this.applicationContext, this.executionContext) });
    return Promise.resolve({ name });
  }
}

@Action({
  name: "hold-action",
  description: "Holds the job until its process's gate opens",
  input: { job: JobDto },
  output: DoneDto,
  deps: [ApplicationContext, ExecutionContext],
})
export class HoldAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: { readonly job: Produced<JobDto, unknown> }): Promise<DoneDto> {
    const { name } = input.job.value;
    const where = whereOf(this.applicationContext, this.executionContext);
    emit("holding", { name, ...where });
    await atGate(this.executionContext.signal);
    return { name, by: where.instanceId };
  }
}

@WorkflowStart({ name: "takeover-workflow-start", description: "A job to hold", input: JobDto })
export class TakeoverWorkflowStart {}

@WorkflowFinish({ name: "takeover-workflow-finish", description: "Held", output: DoneDto })
export class TakeoverWorkflowFinish {}

@Workflow({
  name: "takeover-workflow",
  version: "1.0.0",
  flow: [
    start(TakeoverWorkflowStart)
      .returns(JobDto)
      .toAction(PrepareAction)
      .returns(JobDto)
      .toAction(HoldAction)
      .returns(DoneDto)
      .toFinish(TakeoverWorkflowFinish),
  ],
})
export class TakeoverWorkflow {}
