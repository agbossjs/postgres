/**
 * agbossjs/agboss#824 AC1: on PostgreSQL the A2A tasks are shared by the instances. One message —
 * one `messageId` — sent to two processes at the same moment (a client's retry landing on another
 * pod) starts exactly one execution: both answers name one task, the limited provider is called
 * once and one execution ends, and either process reads the task the other may have accepted. On
 * each instance's own in-memory task store both would accept it and run it twice.
 */
import { describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { eventsOf, launch, type Instance } from "./instances.js";

const database = testDatabase();

const SKILLS = "https://agboss.dev/a2a/skills/v1";

/** One JSON-RPC call to an instance's A2A listener. */
async function rpc(instance: Instance, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(instance.a2aUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** The limited workflow's start, once, under `messageId`; answered at once (the task as accepted). */
const job = (messageId: string) => ({
  message: {
    messageId,
    role: "ROLE_USER",
    parts: [{ data: { name: "once" }, mediaType: "application/json" }],
    metadata: { [SKILLS]: { skill: "limited-workflow-start" } },
  },
  configuration: { returnImmediately: true },
});

const taskIdOf = (result: unknown): string => (result as { task: { id: string } }).task.id;

/** The task's state on `instance`, read until it is completed (the run holds its call 300 ms). */
async function completedOn(instance: Instance, id: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = (await rpc(instance, "GetTask", { id })) as { status: { state: string } };
    if (task.status.state === "TASK_STATE_COMPLETED") return task.status.state;
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`task ${id} never completed on ${instance.instanceId}`);
}

describe("agbossjs/agboss#824 AC1: one A2A message on two processes", () => {
  it("the same messageId sent to two processes at once: one task, one execution", async () => {
    const a = await launch(database.url());
    const b = await launch(database.url());

    const answers = await Promise.all([
      rpc(a, "SendMessage", job("m-1")),
      rpc(b, "SendMessage", job("m-1")),
    ]);

    const [id] = answers.map(taskIdOf);
    expect(answers.map(taskIdOf)).toEqual([id, id]);
    expect(await completedOn(a, id ?? "")).toBe("TASK_STATE_COMPLETED");
    expect(await completedOn(b, id ?? "")).toBe("TASK_STATE_COMPLETED");
    const starts = [...eventsOf(a, "limited-call"), ...eventsOf(b, "limited-call")].filter(
      (event) => event.phase === "start",
    );
    expect(starts).toHaveLength(1);
    const ends = [...eventsOf(a, "end"), ...eventsOf(b, "end")].filter(
      (event) => event.rootExecutionId === id,
    );
    expect(ends).toHaveLength(1);
    // a resend later, to either process, is the same task again
    expect(taskIdOf(await rpc(b, "SendMessage", job("m-1")))).toBe(id);
    expect(taskIdOf(await rpc(a, "SendMessage", job("m-1")))).toBe(id);
  }, 120_000);
});
