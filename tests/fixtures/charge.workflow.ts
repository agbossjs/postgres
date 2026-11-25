import {
  Action,
  ApplicationContext,
  ExecutionContext,
  Idempotency,
  onStart,
  OutboundRecovery,
  Reconciliation,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { hours, seconds } from "@agboss/core/units";
import { PostgresConnection } from "../../src/index.js";
import { DoneDto, JobDto } from "./dto.js";
import { atGate, emit } from "./process-log.js";

/**
 * agbossjs/agboss#505, #508 — a step that charges an order through a payment gateway, a call that
 * leaves the system (`Idempotency.sendOnce`). The gateway is two tables of the test's schema, beside the
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
    readonly idempotency: Idempotency;
    readonly connection: PostgresConnection;
  },
  name: string,
  byOrder: boolean,
): Promise<DoneDto> {
  const { applicationContext, executionContext, idempotency, connection } = parts;
  const by = applicationContext.instanceId;
  const where = { name, instanceId: by, rootExecutionId: executionContext.root.executionId };
  const outcome = await idempotency.sendOnce<{ orderId: string }, Receipt>({
    name: "charge",
    // the step's own key, or the order's business key
    ...(byOrder ? { key: `order:${name}` } : {}),
    target: "payments",
    operation: "charge",
    request: { orderId: name },
    timeout: seconds(30),
    ttl: hours(48),
    send: async (call) => {
      await connection.pool.query(CHARGE, [call.idempotencyKey, name, by]);
      emit("charging", { ...where, idempotencyKey: call.idempotencyKey, attempt: call.attempt });
      await atGate(call.signal);
      return { receipt: `receipt:${call.idempotencyKey}` };
    },
    // the gateway table is the record of every charge: its "not there" holds at any age (#795)
    recovery: OutboundRecovery.permanentLookup(async (lookup) => {
      emit("reconciling", { ...where, idempotencyKey: lookup.idempotencyKey });
      const { rowCount } = await connection.pool.query(
        "SELECT 1 FROM test_gateway_charges WHERE idempotency_key = $1",
        [lookup.idempotencyKey],
      );
      return rowCount === 1
        ? Reconciliation.completed({ receipt: `receipt:${lookup.idempotencyKey}` })
        : Reconciliation.notExecuted();
    }),
  });
  emit("charged", { ...where, status: outcome.status, receipt: outcome.result.receipt });
  return { name, by };
}

@Action({
  name: "charge-action",
  description: "Charges the job's order, keyed by the step",
  input: { job: JobDto },
  output: DoneDto,
  deps: [ApplicationContext, ExecutionContext, Idempotency, PostgresConnection],
})
export class ChargeAction implements ActionHandler<ChargeAction> {
  constructor(
    readonly applicationContext: ApplicationContext,
    readonly executionContext: ExecutionContext,
    readonly idempotency: Idempotency,
    readonly connection: PostgresConnection,
  ) {}

  execute(input: InputOf<ChargeAction>): Promise<OutputOf<ChargeAction>> {
    return charged(this, input.job.name, false);
  }
}

@Action({
  name: "order-charge-action",
  description: "Charges the job's order, keyed by the order",
  input: { job: JobDto },
  output: DoneDto,
  deps: [ApplicationContext, ExecutionContext, Idempotency, PostgresConnection],
})
export class OrderChargeAction implements ActionHandler<OrderChargeAction> {
  constructor(
    readonly applicationContext: ApplicationContext,
    readonly executionContext: ExecutionContext,
    readonly idempotency: Idempotency,
    readonly connection: PostgresConnection,
  ) {}

  execute(input: InputOf<OrderChargeAction>): Promise<OutputOf<OrderChargeAction>> {
    return charged(this, input.job.name, true);
  }
}

@WorkflowStart({ name: "charge-workflow-start", description: "An order to charge", input: JobDto })
export class ChargeWorkflowStart {}

@WorkflowFinish({ name: "charge-workflow-finish", description: "Charged", output: DoneDto })
export class ChargeWorkflowFinish {}

@Workflow({
  name: "charge-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChargeWorkflowStart).toAction(ChargeAction).toFinish(ChargeWorkflowFinish)],
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OrderChargeWorkflowStart)
      .toAction(OrderChargeAction)
      .toFinish(OrderChargeWorkflowFinish),
  ],
})
export class OrderChargeWorkflow {}
