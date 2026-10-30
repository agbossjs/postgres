/**
 * AC2 (agbossjs/agboss#482): children queued with `ChildPlacement.AnyInstance` are claimed by
 * either instance — two `node` processes on one PostgreSQL — each child exactly once. Each
 * instance has one step slot and each child holds it at its process's gate, so A runs the child it
 * claimed at once, and B, started while the others wait in the queue, claims one at its start;
 * once the gates open, the rest are claimed as the slots free up. No lease runs out: a few seconds.
 *
 * Where the parent ends depends on a race the core leaves open across processes: while A's parent
 * waits for its remote children it releases its lease in the store (#333 PR 4, the yield), and
 * only A's own memory knows it is yielded (`leaseReleases`). B's recovery sweep at its start takes
 * the root over when it runs before B's child worker fills B's one slot: A's execute then rejects
 * with `ExecutionLeaseLostError` (or `RemoteChildLostError`, once B's join removed the children
 * A waits for) and B finishes the parent (reported on agbossjs/agboss#482). Either way each child
 * runs once and the tree finishes once; the test checks both paths.
 */
import { ExecutionLeaseEventKind, type ExecutionLeaseEventRecord } from "@agboss/core";
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
  it("AC2: each AnyInstance child claimed once", async () => {
    const a = await launch(database.url());
    const batch = a
      .send("execute", { workflow: "batch", input: JOBS.map((name) => ({ name })) })
      .then(
        (result) => ({ result: result as { status: string; output: { text: string } } }),
        (error: unknown) => ({ error: String(error) }),
      );
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
    const finisher = "result" in done ? a : b;
    await finisher.next((event) => event.event === "end" && event.executionId === root);

    // every child ran once, on one of the two instances, and both instances ran some
    const ran = [...eventsOf(a, "child-ran"), ...eventsOf(b, "child-ran")];
    expect(ran.map((event) => event.name).sort()).toEqual(JOBS);
    expect(new Set(ran.map((event) => event.executionId)).size).toBe(JOBS.length);
    expect(new Set(ran.map((event) => event.instanceId))).toEqual(
      new Set([a.instanceId, b.instanceId]),
    );
    // the tree finished once, at its finish, on the instance that held it last
    expect([...rootEndsOf(a, root), ...rootEndsOf(b, root)]).toEqual([
      expect.objectContaining({ finish: "batch-workflow-finish" }),
    ]);
    expect(rootEndsOf(finisher, root)).toHaveLength(1);
    if ("result" in done) {
      expect(done.result.status).toBe("finished");
      expect(done.result.output.text.split(", ").sort()).toEqual(JOBS);
    } else {
      // the race: B's sweep took the yielded root over; A's parent stops when it re-acquires the
      // lease, or sooner, when B's join has removed the children it waits for
      expect(done.error).toMatch(
        /ExecutionLeaseLostError: .*another instance took it|RemoteChildLostError: child execution .* is no longer queued/,
      );
      const rows = (await b.send("lease-events", {
        tenantId: String(first.tenantId),
        rootExecutionId: root,
      })) as ExecutionLeaseEventRecord[];
      expect(rows).toContainEqual(
        expect.objectContaining({
          kind: ExecutionLeaseEventKind.Takeover,
          executionId: root,
          holderInstanceId: b.instanceId,
        }),
      );
    }
    // the tree joined its children: none is left in the queue to be claimed again
    expect(await queueOf(root)).toEqual([]);
  }, 120_000);
});
