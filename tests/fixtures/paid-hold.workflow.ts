import {
  Action,
  ApplicationContext,
  ExecutionContext,
  SpendRecorder,
  start,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "@agboss/core";
import { usd } from "@agboss/core/units";
import { DoneDto, JobDto } from "./dto.js";
import { atGate, emit } from "./process-log.js";

/**
 * agbossjs/agboss#634 — a job held at its process's gate (it has spent nothing), then a paid
 * action: when the gate opens after the other process spent the tenant's day, the paid action is
 * refused before it runs — the budgets hold back every step that can spend, not only model steps.
 */

@Action({
  name: "wait-action",
  description: "Waits at its process's gate",
  input: { job: JobDto },
  output: JobDto,
  deps: [ApplicationContext, ExecutionContext],
})
export class WaitAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: { readonly job: Produced<JobDto, unknown> }): Promise<JobDto> {
    const { name } = input.job.value;
    emit("waiting", { name, instanceId: this.applicationContext.instanceId });
    await atGate(this.executionContext.signal);
    return { name };
  }
}

@Action({
  name: "paid-action",
  description: "Pays a service $1 for the job",
  input: { job: JobDto },
  output: DoneDto,
  deps: [ApplicationContext, SpendRecorder],
})
export class PaidAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  execute(input: { readonly job: Produced<JobDto, unknown> }): Promise<DoneDto> {
    const { name } = input.job.value;
    const by = this.applicationContext.instanceId;
    emit("paid", { name, instanceId: by });
    this.spendRecorder.record({ service: "job-api", cost: usd(1) });
    return Promise.resolve({ name, by });
  }
}

@WorkflowStart({ name: "paid-hold-workflow-start", description: "A job to hold", input: JobDto })
export class PaidHoldWorkflowStart {}

@WorkflowFinish({ name: "paid-hold-workflow-finish", description: "Paid", output: DoneDto })
export class PaidHoldWorkflowFinish {}

@Workflow({
  name: "paid-hold-workflow",
  version: "1.0.0",
  flow: [
    start(PaidHoldWorkflowStart)
      .returns(JobDto)
      .toAction(WaitAction)
      .returns(JobDto)
      .toAction(PaidAction)
      .returns(DoneDto)
      .toFinish(PaidHoldWorkflowFinish),
  ],
})
export class PaidHoldWorkflow {}
