/**
 * One application instance of the process tests: run as its own `node` process (`--import tsx`)
 * by `instances.ts`, it creates `ProcessApplication` on `AGBOSS_PROCESS_DATABASE_URL` (its own
 * pool), says `ready` with its instance id, then takes one JSON command per stdin line and answers
 * each with a `reply` line on stdout, carrying the command's `id`. Its recovery sweep and child
 * workers run as in any deployed instance; nothing but the database is shared with the others.
 */
import { createInterface } from "node:readline";
import { ApplicationContext, createApp, type App, type ExecutionOutput } from "@agboss/core";
import { ApprovalWorkflowStart } from "../fixtures/approval.workflow.js";
import { BatchWorkflowStart } from "../fixtures/batch.workflow.js";
import { ProcessApplication } from "../fixtures/process.application.js";
import { emit, openGate } from "../fixtures/process-log.js";
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

/** Starts the named workflow with `input`, checked against its start's input. */
function execute(app: App, workflow: unknown, input: unknown): Promise<ExecutionOutput> {
  const options = { ownerId: OWNER };
  if (workflow === "takeover") return app.execute(TakeoverWorkflowStart, Job.parse(input), options);
  if (workflow === "batch")
    return app.execute(BatchWorkflowStart, z.array(Job).parse(input), options);
  if (workflow === "approval") return app.execute(ApprovalWorkflowStart, Job.parse(input), options);
  throw new Error(`no workflow ${String(workflow)}`);
}

/** What a command answers. */
async function answerOf(app: App, command: Command): Promise<unknown> {
  switch (command.op) {
    case "execute":
      return outputOf(await execute(app, command.workflow, command.input));
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
    emit("reply", { id: command.id, error: String(error) });
  }
  if (command.op === "close") process.exit(0);
}

const app = await createApp(ProcessApplication, { env: "process" });
emit("ready", { instanceId: app.resolve(ApplicationContext).instanceId, pid: process.pid });
createInterface({ input: process.stdin }).on("line", (line) => {
  void answer(app, JSON.parse(line) as Command);
});
