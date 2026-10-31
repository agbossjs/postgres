import {
  Action,
  ApplicationContext,
  ExecutionContext,
  fencedEffectKeyOf,
  OutboundCallReconciliation,
  OutboundCalls,
  start,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "@agboss/core";
import { PostgresConnection } from "../../src/index.js";
import { DoneDto, JobDto } from "./dto.js";
import { atGate, emit } from "./process-log.js";

/**
 * agbossjs/agboss#505, #508 — a step that charges an order through a payment gateway, a call that
 * leaves the system (`OutboundCalls`). The gateway is two tables of the test's schema, beside the
 * stores and outside every store's transaction, as another system is: `test_gateway_attempts`
 * keeps every request that reached it, `test_gateway_charges` one charge per idempotency key (a
 * gateway that deduplicates). The charge is made, then its answer waits at its process's gate: a
 * process frozen there is frozen mid-charge — charged, the answer not stored. `reconcile` looks the
 * charge up by the call's idempotency key. `charge-workflow` keys the call by its step;
 * `order-charge-workflow` by the business key `order:<name>`, one charge per order across trees.
 */

const CHARGE = `WITH attempt AS (
    INSERT INTO test_gateway_attempts (idempotency_key, order_id, instance_id) VALUES ($1, $2, $3)
  )
  INSERT INTO test_gateway_charges (idempotency_key, order_id, instance_id) VALUES ($1, $2, $3)
  ON CONFLICT (idempotency_key) DO NOTHING`;

/** What the gateway answers: the receipt of the charge. */
interface Receipt {
  readonly receipt: string;
}

/** Charges order `name` through the gateway, keyed by the step or by the order's business key. */
async function charged(
  parts: {
    readonly applicationContext: ApplicationContext;
    readonly executionContext: ExecutionContext;
    readonly outboundCalls: OutboundCalls;
    readonly connection: PostgresConnection;
  },
  name: string,
  byOrder: boolean,
): Promise<DoneDto> {
  const { applicationContext, executionContext, outboundCalls, connection } = parts;
  const by = applicationContext.instanceId;
  const options = byOrder ? { businessKey: `order:${name}` } : undefined;
  const key = fencedEffectKeyOf(executionContext, "charge", options);
  const where = { name, instanceId: by, rootExecutionId: executionContext.root.executionId };
  const outcome = await outboundCalls.send<{ orderId: string }, Receipt>(key, {
    target: "payments",
    operation: "charge",
    request: { orderId: name },
    send: async (call) => {
      await connection.pool.query(CHARGE, [call.idempotencyKey, name, by]);
      emit("charging", { ...where, idempotencyKey: call.idempotencyKey, attempt: call.attempt });
      await atGate(call.signal);
      return { receipt: `receipt:${call.idempotencyKey}` };
    },
    reconcile: async (lookup) => {
      emit("reconciling", { ...where, idempotencyKey: lookup.idempotencyKey });
      const { rowCount } = await connection.pool.query(
        "SELECT 1 FROM test_gateway_charges WHERE idempotency_key = $1",
        [lookup.idempotencyKey],
      );
      return rowCount === 1
        ? OutboundCallReconciliation.completed({ receipt: `receipt:${lookup.idempotencyKey}` })
        : OutboundCallReconciliation.notSent();
    },
  });
  emit("charged", { ...where, status: outcome.status, receipt: outcome.result.receipt });
  return { name, by };
}

@Action({
  name: "charge-action",
  description: "Charges the job's order, keyed by the step",
  input: { job: JobDto },
  output: DoneDto,
  deps: [ApplicationContext, ExecutionContext, OutboundCalls, PostgresConnection],
})
export class ChargeAction {
  constructor(
    readonly applicationContext: ApplicationContext,
    readonly executionContext: ExecutionContext,
    readonly outboundCalls: OutboundCalls,
    readonly connection: PostgresConnection,
  ) {}

  execute(input: { readonly job: Produced<JobDto, unknown> }): Promise<DoneDto> {
    return charged(this, input.job.value.name, false);
  }
}

@Action({
  name: "order-charge-action",
  description: "Charges the job's order, keyed by the order",
  input: { job: JobDto },
  output: DoneDto,
  deps: [ApplicationContext, ExecutionContext, OutboundCalls, PostgresConnection],
})
export class OrderChargeAction {
  constructor(
    readonly applicationContext: ApplicationContext,
    readonly executionContext: ExecutionContext,
    readonly outboundCalls: OutboundCalls,
    readonly connection: PostgresConnection,
  ) {}

  execute(input: { readonly job: Produced<JobDto, unknown> }): Promise<DoneDto> {
    return charged(this, input.job.value.name, true);
  }
}

@WorkflowStart({ name: "charge-workflow-start", description: "An order to charge", input: JobDto })
export class ChargeWorkflowStart {}

@WorkflowFinish({ name: "charge-workflow-finish", description: "Charged", output: DoneDto })
export class ChargeWorkflowFinish {}

@Workflow({
  name: "charge-workflow",
  version: "1.0.0",
  flow: [
    start(ChargeWorkflowStart)
      .returns(JobDto)
      .toAction(ChargeAction)
      .returns(DoneDto)
      .toFinish(ChargeWorkflowFinish),
  ],
})
export class ChargeWorkflow {}

@WorkflowStart({
  name: "order-charge-workflow-start",
  description: "An order to charge once",
  input: JobDto,
})
export class OrderChargeWorkflowStart {}

@WorkflowFinish({
  name: "order-charge-workflow-finish",
  description: "Charged once",
  output: DoneDto,
})
export class OrderChargeWorkflowFinish {}

@Workflow({
  name: "order-charge-workflow",
  version: "1.0.0",
  flow: [
    start(OrderChargeWorkflowStart)
      .returns(JobDto)
      .toAction(OrderChargeAction)
      .returns(DoneDto)
      .toFinish(OrderChargeWorkflowFinish),
  ],
})
export class OrderChargeWorkflow {}
