import {
  Agent,
  ApplicationContext,
  Channel,
  ChannelOf,
  ChannelOutcome,
  ChannelRole,
  PauseAnswerer,
  start,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ToolHandler,
} from "@agboss/core";
import {
  ModelCost,
  ModelProvider,
  ModelProviderMessageRole,
  RetryPolicy,
  type ModelProviderRequest,
  type ModelProviderResponse,
} from "@agboss/core/models";
import { minutes, seconds, usd } from "@agboss/core/units";
import { DoneDto, JobDto } from "./dto.js";
import { emit } from "./process-log.js";

/**
 * AC3 — a clerk agent that ships a job through `ship-tool`, whose channel only queues the ask: the
 * execution pauses, its pause kept in PostgreSQL, until a resume answers it — on any instance.
 * The model is a deterministic provider of this file: first it calls the tool, then, once the
 * tool's result is in the conversation, it answers with that result.
 */

@ChannelRole({
  name: "ship-approval-channel",
  description: "An operator approves shipping a job",
  approves: JobDto,
  answeredBy: PauseAnswerer.ThreadOwner,
})
export abstract class ShipApprovalChannel extends ChannelOf<ShipApprovalChannel> {}

@Channel({ name: "queued-ship-approval-channel", description: "Leaves the ask in the pause store" })
export class QueuedShipApprovalChannel extends ShipApprovalChannel {
  send(): Promise<ChannelOutcome<ShipApprovalChannel>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "ship-tool",
  description: "Ships the job, once an operator approved it",
  input: JobDto,
  output: DoneDto,
  channel: ShipApprovalChannel,
  deps: [ApplicationContext],
})
export class ShipTool implements ToolHandler<JobDto, DoneDto> {
  constructor(private readonly applicationContext: ApplicationContext) {}

  run({ name }: JobDto): Promise<DoneDto> {
    const { instanceId } = this.applicationContext;
    emit("shipped", { name, instanceId });
    return Promise.resolve({ name, by: instanceId });
  }
}

/** The first `"key": "value"` of `text`. */
const fieldOf = (text: string, key: string): string =>
  new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "u").exec(text)?.[1] ?? "";

const USAGE = { inputTokens: 10, outputTokens: 5 };

@ModelProvider({
  name: "offline-clerk-model-provider",
  description: "A deterministic clerk: ships the job, then answers with what was shipped",
  serves: [/^offline\//u],
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(10) },
})
export class OfflineClerkModelProvider {
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const shipped = request.messages.find((line) => line.role === ModelProviderMessageRole.Tool);
    const asked = request.messages.find((line) => line.role === ModelProviderMessageRole.User);
    const answer = request.tools.find((tool) => tool.name.startsWith("answer-"))?.name ?? "";
    const call =
      shipped === undefined
        ? {
            id: "call-ship",
            name: request.tools.find((tool) => !tool.name.startsWith("answer-"))?.name ?? "",
            arguments: { name: fieldOf(asked?.text ?? "", "name") },
          }
        : {
            id: "call-answer",
            name: answer,
            arguments: { name: fieldOf(shipped.text, "name"), by: fieldOf(shipped.text, "by") },
          };
    return Promise.resolve({ text: "", toolCalls: [call], usage: USAGE, cost: usd(0.0001) });
  }
}

@Agent({
  name: "clerk-agent",
  description: "Ships a job",
  prompt: "Ship the job with ship-tool, then answer with what was shipped.",
  model: "offline/clerk",
  input: { job: JobDto },
  output: DoneDto,
  tools: [ShipTool],
  maxToolCalls: 2,
})
export class ClerkAgent {}

@WorkflowStart({ name: "approval-workflow-start", description: "A job to ship", input: JobDto })
export class ApprovalWorkflowStart {}

@WorkflowFinish({ name: "approval-workflow-finish", description: "Shipped", output: DoneDto })
export class ApprovalWorkflowFinish {}

@Workflow({
  name: "approval-workflow",
  version: "1.0.0",
  flow: [
    start(ApprovalWorkflowStart)
      .returns(JobDto)
      .toAgent(ClerkAgent)
      .returns(DoneDto)
      .toFinish(ApprovalWorkflowFinish),
  ],
})
export class ApprovalWorkflow {}

/** The same shipping, a second time: its own tool, so its call asks its own approval. */
@Tool({
  name: "reship-tool",
  description: "Ships the job once more, once an operator approved it",
  input: JobDto,
  output: DoneDto,
  channel: ShipApprovalChannel,
  deps: [ApplicationContext],
})
export class ReshipTool implements ToolHandler<JobDto, DoneDto> {
  constructor(private readonly applicationContext: ApplicationContext) {}

  run({ name }: JobDto): Promise<DoneDto> {
    const { instanceId } = this.applicationContext;
    emit("shipped", { name, instanceId });
    return Promise.resolve({ name, by: instanceId });
  }
}

/**
 * agbossjs/agboss#682 — a second approval on the same tree: the clerk's job shipped again by a
 * recheck clerk, whose call waits for its own answer. Two pauses, two resumes: the second resume
 * continues from the checkpoint the first one's pass wrote last.
 */
@Agent({
  name: "recheck-clerk-agent",
  description: "Ships a shipped job once more",
  prompt: "Ship the job with ship-tool, then answer with what was shipped.",
  model: "offline/clerk",
  input: { done: DoneDto },
  output: DoneDto,
  tools: [ReshipTool],
  maxToolCalls: 2,
})
export class RecheckClerkAgent {}

@WorkflowStart({
  name: "two-approvals-workflow-start",
  description: "A job to ship twice",
  input: JobDto,
})
export class TwoApprovalsWorkflowStart {}

@WorkflowFinish({
  name: "two-approvals-workflow-finish",
  description: "Shipped twice",
  output: DoneDto,
})
export class TwoApprovalsWorkflowFinish {}

@Workflow({
  name: "two-approvals-workflow",
  version: "1.0.0",
  flow: [
    start(TwoApprovalsWorkflowStart)
      .returns(JobDto)
      .toAgent(ClerkAgent)
      .returns(DoneDto)
      .toAgent(RecheckClerkAgent)
      .returns(DoneDto)
      .toFinish(TwoApprovalsWorkflowFinish),
  ],
})
export class TwoApprovalsWorkflow {}
