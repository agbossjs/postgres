import {
  Action,
  ApplicationContext,
  ChildPlacement,
  ExecutionContext,
  listOf,
  onStart,
  SpendRecorder,
  toWorkflow,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { usd } from "@agboss/core/units";
import { DoneDto, JobDto, SummaryDto } from "./dto.js";
import { atGate, emit } from "./process-log.js";

/**
 * agbossjs/agboss#727 — a tree's spend in flight seen by its own children on the other process.
 * One child per job, queued with `ChildPlacement.AnyWorker` (the child's own placement); each child pays $0.60, tells the
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
export class PayFirstAction implements ActionHandler<PayFirstAction> {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  async execute(input: InputOf<PayFirstAction>): Promise<OutputOf<PayFirstAction>> {
    const { name } = input.job;
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
export class PaySecondAction implements ActionHandler<PaySecondAction> {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  execute(input: InputOf<PaySecondAction>): Promise<OutputOf<PaySecondAction>> {
    return paidStep("pay-second", input.job, this.applicationContext, this.spendRecorder);
  }
}

@Action({
  name: "pay-third-action",
  description: "Pays $0.30 for the job",
  input: { job: JobDto },
  output: JobDto,
  deps: [ApplicationContext, SpendRecorder],
})
export class PayThirdAction implements ActionHandler<PayThirdAction> {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  execute(input: InputOf<PayThirdAction>): Promise<OutputOf<PayThirdAction>> {
    return paidStep("pay-third", input.job, this.applicationContext, this.spendRecorder);
  }
}

@Action({
  name: "pay-done-action",
  description: "The job is paid",
  input: { job: JobDto },
  output: DoneDto,
  deps: [ApplicationContext],
})
export class PayDoneAction implements ActionHandler<PayDoneAction> {
  constructor(private readonly applicationContext: ApplicationContext) {}

  execute(input: InputOf<PayDoneAction>): Promise<OutputOf<PayDoneAction>> {
    return Promise.resolve({ name: input.job.name, by: this.applicationContext.instanceId });
  }
}

@WorkflowStart({ name: "pay-item-workflow-start", description: "One job", input: JobDto })
export class PayItemWorkflowStart {}

@WorkflowFinish({ name: "pay-item-workflow-finish", description: "Paid", output: DoneDto })
export class PayItemWorkflowFinish {}

@Workflow({
  name: "pay-item-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  placement: ChildPlacement.AnyWorker,
  flow: [
    onStart(PayItemWorkflowStart)
      .toAction(PayFirstAction)
      .toAction(PaySecondAction)
      .toAction(PayThirdAction)
      .toAction(PayDoneAction)
      .toFinish(PayItemWorkflowFinish),
  ],
})
export class PayItemWorkflow {}

@WorkflowStart({ name: "pay-items-workflow-start", description: "The jobs", input: listOf(JobDto) })
export class PayItemsWorkflowStart {}

@Action({
  name: "pay-items-summary-action",
  description: "Sums the jobs paid up",
  input: { results: listOf(DoneDto) },
  output: SummaryDto,
})
export class PayItemsSummaryAction implements ActionHandler<PayItemsSummaryAction> {
  execute(input: InputOf<PayItemsSummaryAction>): Promise<OutputOf<PayItemsSummaryAction>> {
    return Promise.resolve({ text: input.results.map((result) => result.name).join(", ") });
  }
}

@WorkflowFinish({
  name: "pay-items-workflow-finish",
  description: "Every job, paid",
  output: SummaryDto,
})
export class PayItemsWorkflowFinish {}

@Workflow({
  name: "pay-items-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PayItemsWorkflowStart)
      .forEachItem(toWorkflow(PayItemWorkflow), { takeFirst: 2, maxConcurrency: 2 })
      .join()
      .toAction(PayItemsSummaryAction)
      .toFinish(PayItemsWorkflowFinish),
  ],
})
export class PayItemsWorkflow {}
