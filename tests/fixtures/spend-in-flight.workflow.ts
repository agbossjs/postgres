import {
  Action,
  ApplicationContext,
  ChildPlacement,
  ExecutionContext,
  listOf,
  SpendRecorder,
  start,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "@agboss/core";
import { usd } from "@agboss/core/units";
import { DoneDto, JobDto, SummaryDto } from "./dto.js";
import { atGate, emit } from "./process-log.js";

/**
 * agbossjs/agboss#727 — a tree's spend in flight seen by its own children on the other process.
 * One child per job, queued with `ChildPlacement.AnyInstance`; each child pays $0.60, tells the
 * test and waits at its process's gate, then pays $0.30 twice. The execution may spend $1: with
 * one child holding its $0.60 at one process's gate, the other child — on the other process —
 * pays its $0.60 (it read $0.60 of $1) and is held back at its next step ($1.20), because the
 * first child's spend is in the ledger the moment it was made, not at the end of its superstep.
 */

@Action({
  name: "pay-first-action",
  description: "Pays $0.60 for the job, then waits at its process's gate",
  input: { job: JobDto },
  output: JobDto,
  deps: [ApplicationContext, ExecutionContext, SpendRecorder],
})
export class PayFirstAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  async execute(input: { readonly job: Produced<JobDto, unknown> }): Promise<JobDto> {
    const { name } = input.job.value;
    this.spendRecorder.record({ service: "job-api", cost: usd(0.6) });
    emit("paying", { name, instanceId: this.applicationContext.instanceId });
    await atGate(this.executionContext.signal);
    return { name };
  }
}

/** A paid step after the first: $0.30, told to the test. */
function paidStep(
  step: string,
  job: JobDto,
  applicationContext: ApplicationContext,
  spendRecorder: SpendRecorder,
): Promise<JobDto> {
  emit("paid-step", { name: job.name, step, instanceId: applicationContext.instanceId });
  spendRecorder.record({ service: "job-api", cost: usd(0.3) });
  return Promise.resolve({ name: job.name });
}

@Action({
  name: "pay-second-action",
  description: "Pays $0.30 for the job",
  input: { job: JobDto },
  output: JobDto,
  deps: [ApplicationContext, SpendRecorder],
})
export class PaySecondAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  execute(input: { readonly job: Produced<JobDto, unknown> }): Promise<JobDto> {
    return paidStep("pay-second", input.job.value, this.applicationContext, this.spendRecorder);
  }
}

@Action({
  name: "pay-third-action",
  description: "Pays $0.30 for the job",
  input: { job: JobDto },
  output: JobDto,
  deps: [ApplicationContext, SpendRecorder],
})
export class PayThirdAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  execute(input: { readonly job: Produced<JobDto, unknown> }): Promise<JobDto> {
    return paidStep("pay-third", input.job.value, this.applicationContext, this.spendRecorder);
  }
}

@Action({
  name: "pay-done-action",
  description: "The job is paid",
  input: { job: JobDto },
  output: DoneDto,
  deps: [ApplicationContext],
})
export class PayDoneAction {
  constructor(private readonly applicationContext: ApplicationContext) {}

  execute(input: { readonly job: Produced<JobDto, unknown> }): Promise<DoneDto> {
    return Promise.resolve({ name: input.job.value.name, by: this.applicationContext.instanceId });
  }
}

@WorkflowStart({ name: "pay-item-workflow-start", description: "One job", input: JobDto })
export class PayItemWorkflowStart {}

@WorkflowFinish({ name: "pay-item-workflow-finish", description: "Paid", output: DoneDto })
export class PayItemWorkflowFinish {}

@Workflow({
  name: "pay-item-workflow",
  version: "1.0.0",
  flow: [
    start(PayItemWorkflowStart)
      .returns(JobDto)
      .toAction(PayFirstAction)
      .returns(JobDto)
      .toAction(PaySecondAction)
      .returns(JobDto)
      .toAction(PayThirdAction)
      .returns(JobDto)
      .toAction(PayDoneAction)
      .returns(DoneDto)
      .toFinish(PayItemWorkflowFinish),
  ],
})
export class PayItemWorkflow {}

@WorkflowStart({ name: "pay-items-workflow-start", description: "The jobs", input: listOf(JobDto) })
export class PayItemsWorkflowStart {}

@WorkflowFinish({
  name: "pay-items-workflow-finish",
  description: "Every job, paid",
  input: { results: listOf(DoneDto) },
  output: SummaryDto,
})
export class PayItemsWorkflowFinish {
  finish(input: { readonly results: readonly Produced<DoneDto, unknown>[] }): SummaryDto {
    return { text: input.results.map((result) => result.value.name).join(", ") };
  }
}

@Workflow({
  name: "pay-items-workflow",
  version: "1.0.0",
  flow: [
    start(PayItemsWorkflowStart)
      .returns(listOf(JobDto))
      .toParallelWorkflows(PayItemWorkflow, {
        maxItems: 2,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(DoneDto))
      .toFinish(PayItemsWorkflowFinish),
  ],
})
export class PayItemsWorkflow {}
