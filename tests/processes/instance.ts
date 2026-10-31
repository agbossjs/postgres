/**
 * One application instance of the process tests: run as its own `node` process (`--import tsx`)
 * by `instances.ts`, it creates `ProcessApplication` on `AGBOSS_PROCESS_DATABASE_URL` (its own
 * pool), serves it over A2A on a port of its own, says `ready` with its instance id and that port,
 * then takes one JSON command per stdin line and answers each with a `reply` line on stdout,
 * carrying the command's `id` (a failure: its error's text and name). Its recovery sweep and child
 * workers run as in any deployed instance; nothing but the database is shared with the others.
 */
// first: a process whose clock is off (agbossjs/agboss#533), before anything reads the time
import "../fixtures/skewed-date.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { ApplicationContext, createApp, type App, type ExecutionOutput } from "@agboss/core";
import { ApprovalWorkflowStart } from "../fixtures/approval.workflow.js";
import { BatchWorkflowStart } from "../fixtures/batch.workflow.js";
import { ChargeWorkflowStart, OrderChargeWorkflowStart } from "../fixtures/charge.workflow.js";
import { a2aHttpListener } from "@agboss/core/a2a";
import { holdAcquireOf, letAcquireGo } from "../fixtures/held-lease.repository.js";
import { ProcessApplication } from "../fixtures/process.application.js";
import { emit, openGate } from "../fixtures/process-log.js";
import {
  LimitedWorkflowStart,
  OrdersCallerResolver,
  ProcessA2AExpose,
  SpendWorkflowStart,
} from "../fixtures/shared.workflow.js";
import { TakeoverWorkflowStart } from "../fixtures/takeover.workflow.js";
import { z } from "zod";

/** The owner of every thread the tests start: the one who answers their pauses. */
const OWNER = "operator-1";

/** A command of the test. */
interface Command {
  readonly id: number;
  readonly op: string;
  readonly [field: string]: unknown;
}

/** What a test reads of an execution's output. */
const outputOf = (done: ExecutionOutput) => ({
  status: done.status,
  executionId: done.executionId,
  threadId: done.threadId,
  tenantId: done.tenantId,
  output: done.output,
  finish: done.finish?.name,
  pending: done.pending.map((pause) => ({ pauseId: pause.pauseId, channel: pause.channel })),
});

/** A job the test sends: `{ name }`. */
const Job = z.object({ name: z.string() });

/** How an execution is started: its owner and, when the test names one, its tenant. */
type Options = Parameters<App["execute"]>[2];

/** Each workflow a test runs, started with the job(s) the test sent. */
const STARTS: Readonly<
  Record<string, (app: App, input: unknown, options: Options) => Promise<ExecutionOutput>>
> = {
  takeover: (app, input, options) => app.execute(TakeoverWorkflowStart, Job.parse(input), options),
  approval: (app, input, options) => app.execute(ApprovalWorkflowStart, Job.parse(input), options),
  spend: (app, input, options) => app.execute(SpendWorkflowStart, Job.parse(input), options),
  limited: (app, input, options) => app.execute(LimitedWorkflowStart, Job.parse(input), options),
  charge: (app, input, options) => app.execute(ChargeWorkflowStart, Job.parse(input), options),
  "order-charge": (app, input, options) =>
    app.execute(OrderChargeWorkflowStart, Job.parse(input), options),
  batch: (app, input, options) =>
    app.execute(BatchWorkflowStart, z.array(Job).parse(input), options),
};

/** Starts the named workflow with `input`, checked against its start's input, for `tenantId`. */
function execute(
  app: App,
  workflow: unknown,
  input: unknown,
  tenantId: unknown,
): Promise<ExecutionOutput> {
  const tenant = typeof tenantId === "string" ? { tenant: { tenantId } } : {};
  const run = STARTS[String(workflow)];
  if (run === undefined) throw new Error(`no workflow ${String(workflow)}`);
  return run(app, input, { ownerId: OWNER, ...tenant });
}

/** What a command answers. */
async function answerOf(app: App, command: Command): Promise<unknown> {
  switch (command.op) {
    case "execute":
      return outputOf(await execute(app, command.workflow, command.input, command.tenantId));
    case "resume":
      return outputOf(
        await app.resume(
          { pauseId: String(command.pauseId), decision: command.decision },
          { ownerId: OWNER },
        ),
      );
    case "lease-events":
      return app.leaseEventsOf({
        tenantId: String(command.tenantId),
        rootExecutionId: String(command.rootExecutionId),
      });
    case "hold-acquire":
      holdAcquireOf(String(command.key));
      return "held";
    case "let-acquire":
      letAcquireGo(String(command.key));
      return "let";
    case "open":
      openGate();
      return "open";
    case "close":
      await app.close();
      return "closed";
    default:
      throw new Error(`no command ${command.op}`);
  }
}

async function answer(app: App, command: Command): Promise<void> {
  try {
    emit("reply", { id: command.id, result: await answerOf(app, command) });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : typeof error;
    emit("reply", { id: command.id, error: String(error), errorName });
  }
  if (command.op === "close") process.exit(0);
}

const app = await createApp(ProcessApplication, { env: "process" });
const server = createServer(
  a2aHttpListener(app, { expose: ProcessA2AExpose, callerResolver: OrdersCallerResolver }),
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const { instanceId } = app.resolve(ApplicationContext);
emit("ready", { instanceId, pid: process.pid, port });
createInterface({ input: process.stdin }).on("line", (line) => {
  void answer(app, JSON.parse(line) as Command);
});
