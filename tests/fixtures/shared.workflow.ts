import {
  Agent,
  ApplicationContext,
  Budget,
  BudgetScope,
  Clock,
  HttpAuthenticator,
  HttpAuthResult,
  inline,
  onStart,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type BudgetHandler,
} from "@agboss/core";
import { A2AEndpoint } from "@agboss/core/a2a";
import {
  CircuitBreakerPolicy,
  ModelCost,
  ModelProvider,
  RateLimitPolicy,
  type ModelProviderRequest,
  type ModelProviderResponse,
} from "@agboss/core/models";
import { hours, minutes, seconds, usd, type Usd } from "@agboss/core/units";
import { DoneDto, JobDto } from "./dto.js";
import { emit } from "./process-log.js";

/**
 * The stores of agbossjs/agboss#483 across processes: a model provider of fixed cost (AC1, the
 * tenant's day) and one limited to a call at a time across every instance (AC2), which tells the
 * test when each call starts and ends on the `Clock`; the limited workflow is also served over A2A
 * to the trusted `orders-application` (AC4). Both providers answer at once with the job's name.
 */

/** What one priced call costs: two calls spend the tenant's $10 day. */
export const PRICED_CALL_USD = 5;
/** How long a limited call holds its slot: long enough for the other process to try for it. */
const HOLD = seconds(0.3);

/** The answer tool's call: the job's name and the instance that answered. */
function answerOf(request: ModelProviderRequest, by: string): ModelProviderResponse["toolCalls"] {
  const asked = request.messages.find((line) => line.text.includes('"name"'))?.text ?? "";
  const name = /"name"\s*:\s*"([^"]+)"/u.exec(asked)?.[1] ?? "";
  const answer = request.tools.find((tool) => tool.name.startsWith("answer-"))?.name ?? "";
  return [{ id: "call-answer", name: answer, arguments: { name, by } }];
}

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const BREAKER = CircuitBreakerPolicy.fixed({
  failureThreshold: 5,
  failureWindow: minutes(1),
  openDuration: seconds(10),
});

@ModelProvider({
  name: "priced-model-provider",
  description: "A scripted transport: answers at once, each call costs $5",
  model: "priced/clerk",
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
  circuitBreakerPolicy: BREAKER,
  deps: [ApplicationContext],
})
export class PricedModelProvider {
  constructor(private readonly applicationContext: ApplicationContext) {}

  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const { instanceId } = this.applicationContext;
    emit("priced-call", { instanceId });
    const toolCalls = answerOf(request, instanceId);
    return Promise.resolve({ text: "", toolCalls, usage: USAGE, cost: usd(PRICED_CALL_USD) });
  }
}

@ModelProvider({
  name: "limited-model-provider",
  description: "A scripted transport: one call at a time across instances, each held 300 ms",
  model: "limited/clerk",
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
  circuitBreakerPolicy: BREAKER,
  rateLimitPolicy: RateLimitPolicy.of({ maxConcurrentCalls: 1 }),
  deps: [ApplicationContext, Clock],
})
export class LimitedModelProvider {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly clock: Clock,
  ) {}

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const { instanceId } = this.applicationContext;
    emit("limited-call", { phase: "start", instanceId, at: this.clock.now().getTime() });
    await this.clock.sleep(HOLD);
    emit("limited-call", { phase: "end", instanceId, at: this.clock.now().getTime() });
    const toolCalls = answerOf(request, instanceId);
    return { text: "", toolCalls, usage: USAGE, cost: usd(0.0001) };
  }
}

@Agent({
  name: "spender-agent",
  description: "Answers with the job's name; its one call is priced",
  prompt: inline("Answer with the job's name."),
  modelProvider: PricedModelProvider,
  input: { job: JobDto },
  output: DoneDto,
})
export class SpenderAgent {}

@Agent({
  name: "limited-agent",
  description: "Answers with the job's name through the limited provider",
  prompt: inline("Answer with the job's name."),
  modelProvider: LimitedModelProvider,
  input: { job: JobDto },
  output: DoneDto,
})
export class LimitedAgent {}

@WorkflowStart({ name: "spend-workflow-start", description: "A job to price", input: JobDto })
export class SpendWorkflowStart {}

@WorkflowFinish({ name: "spend-workflow-finish", description: "Priced", output: DoneDto })
export class SpendWorkflowFinish {}

@Workflow({
  name: "spend-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(SpendWorkflowStart).toAgent(SpenderAgent).toFinish(SpendWorkflowFinish)],
})
export class SpendWorkflow {}

/** The spend workflow's own execution budget: only the tenant's day limits it. */
@Budget({ name: "spend-execution-budget", scope: BudgetScope.Execution, workflow: SpendWorkflow })
export class SpendExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(100);
  }
}

/** Every caller is the mesh peer `orders-application` (as if its transport proved it). */
@HttpAuthenticator({
  name: "orders-http-authenticator",
  description: "Every caller is the orders application",
})
export class OrdersAuthenticator {
  authenticate(): HttpAuthResult {
    // an owner of its own: a caller with none is given a new one for every message, so no messageId would dedupe
    return HttpAuthResult.authenticated({
      peer: "orders-application",
      ownerId: "orders-application",
    });
  }
}

@WorkflowStart({ name: "limited-workflow-start", description: "A job to answer", input: JobDto })
export class LimitedWorkflowStart {}

@WorkflowFinish({ name: "limited-workflow-finish", description: "Answered", output: DoneDto })
export class LimitedWorkflowFinish {}

@Workflow({
  name: "limited-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(LimitedWorkflowStart).toAgent(LimitedAgent).toFinish(LimitedWorkflowFinish)],
})
export class LimitedWorkflow {}

/** AC4: what the processes serve over A2A — the limited workflow. */
@A2AEndpoint({
  name: "process-a2a-endpoint",
  version: "1.0.0",
  description: "Answers jobs",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [{ start: LimitedWorkflowStart, tags: ["jobs"] }],
})
export class ProcessA2AEndpoint {}
