/**
 * AC2 (agbossjs/agboss#482): children queued with `ChildPlacement.AnyInstance` are claimed by
 * either instance — two `node` processes on one PostgreSQL — each child exactly once. Each
 * instance has one step slot and each child holds it at its process's gate, so A runs the child it
 * claimed at once, and B, started while the others wait in the queue, claims one at its start;
 * once the gates open, the rest are claimed as the slots free up. No lease runs out: a few seconds.
 *
 * While A's parent waits for its remote children it yields its lease in the store — still A's,
 * renewed on (agbossjs/agboss#516) — so B's recovery sweep at its start, with its one slot free,
 * finds the root held and takes nothing over: A's execute gets the finished output, A ends the
 * tree, and the lease log has no takeover of the root (before #516 the yield was a release, and B
 * took the root over in 15 of 16 runs under load).
 */
import {
  ExecutionLeaseEventKind,
  LeaseTakeoverReason,
  type ExecutionLeaseEventRecord,
} from "@agboss/core";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { eventsOf, launch, type Instance, type InstanceEvent } from "./instances.js";

const database = testDatabase();

const JOBS = ["a", "b", "c", "d", "e"];

interface QueueRow {
  readonly execution_id: string;
  readonly status: string;
  readonly instance_id: string | null;
}

/** The tree's rows of the child queue, by execution id. */
const queueOf = async (root: string): Promise<QueueRow[]> =>
  (
    await onSchema(
      database.url(),
      `SELECT execution_id, status, instance_id FROM agboss_child_execution_queue
       WHERE root_execution_id = $1 ORDER BY execution_id`,
      [root],
    )
  ).rows as QueueRow[];

/** The ends of `root` itself an instance told. */
const rootEndsOf = (instance: Instance, root: string): readonly InstanceEvent[] =>
  eventsOf(instance, "end").filter((event) => event.executionId === root);

describe("AC2: AnyInstance children across two processes", () => {
  it("AC2: each AnyInstance child claimed once, and the caller of execute gets the finished output (agbossjs/agboss#516)", async () => {
    const a = await launch(database.url());
    const batch = a.send("execute", {
      workflow: "batch",
      input: JOBS.map((name) => ({ name })),
    }) as Promise<{ status: string; output: { text: string } }>;
    const first = await a.next((event) => event.event === "child-ran");
    const root = String(first.rootExecutionId);
    const b = await launch(database.url());
    const second = await b.next((event) => event.event === "child-ran");

    // both instances hold a child of the one tree at the same time: the queue's rows say who
    expect(second.rootExecutionId).toBe(root);
    expect(second.name).not.toBe(first.name);
    const held = await queueOf(root);
    expect(held).toHaveLength(JOBS.length);
    expect(held.filter((row) => row.instance_id !== null)).toEqual(
      [
        { execution_id: String(first.executionId), status: "running", instance_id: a.instanceId },
        {
          execution_id: String(second.executionId),
          status: "running",
          instance_id: b.instanceId,
        },
      ].sort((left, right) => left.execution_id.localeCompare(right.execution_id)),
    );
    expect(held.filter((row) => row.instance_id === null).map((row) => row.status)).toEqual(
      Array.from({ length: JOBS.length - 2 }, () => "queued"),
    );

    await Promise.all([a.send("open"), b.send("open")]);
    const done = await batch;
    await a.next((event) => event.event === "end" && event.executionId === root);

    // the caller of execute gets the finished output: every child's result, in the join
    expect(done.status).toBe("finished");
    expect(done.output.text.split(", ").sort()).toEqual(JOBS);
    // every child ran once, on one of the two instances, and both instances ran some
    const ran = [...eventsOf(a, "child-ran"), ...eventsOf(b, "child-ran")];
    expect(ran.map((event) => event.name).sort()).toEqual(JOBS);
    expect(new Set(ran.map((event) => event.executionId)).size).toBe(JOBS.length);
    expect(new Set(ran.map((event) => event.instanceId))).toEqual(
      new Set([a.instanceId, b.instanceId]),
    );
    // the tree finished once, at its finish, on A, which held it all along
    expect([...rootEndsOf(a, root), ...rootEndsOf(b, root)]).toEqual([
      expect.objectContaining({ finish: "batch-workflow-finish" }),
    ]);
    expect(rootEndsOf(a, root)).toHaveLength(1);
    // no instance took the root's lease over: only A's own reclaims after each wait
    const rows = (await b.send("lease-events", {
      tenantId: String(first.tenantId),
      rootExecutionId: root,
    })) as ExecutionLeaseEventRecord[];
    const rootTakes = rows.filter(
      (row) => row.kind === ExecutionLeaseEventKind.Takeover && row.executionId === root,
    );
    expect(rootTakes.length).toBeGreaterThan(0);
    expect(
      new Set(
        rootTakes.map((row) => `${row.holderInstanceId} ${"reason" in row ? row.reason : ""}`),
      ),
    ).toEqual(new Set([`${a.instanceId} ${LeaseTakeoverReason.Reacquired}`]));
    // the tree joined its children: none is left in the queue to be claimed again
    expect(await queueOf(root)).toEqual([]);
  }, 120_000);
});
