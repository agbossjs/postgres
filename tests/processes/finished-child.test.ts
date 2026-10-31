/**
 * AC1 (agbossjs/agboss#520) on PostgreSQL: two `node` processes, A and B. A's batch waits for its
 * two `AnyInstance` children; each instance claims one, at its gate. A's child ends, so A has a free
 * step slot, and A's worker asks the lease store for B's running child's lease (B's claim may be
 * stale): the ask is held in A's store
 * (`hold-acquire`), A is frozen (SIGSTOP), B answers the child and finishes its lease, A is thawed
 * (SIGCONT) and its ask goes on. The store refuses it in the `acquire` statement itself: no lease of
 * the finished child is A's, and the lease log has no takeover of it. Against a `finish` that is a
 * plain `release` the ask took the child's lease at epoch 2 (the test fails: it bites).
 */
import { ExecutionLeaseEventKind, type ExecutionLeaseEventRecord } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { eventsOf, launch } from "./instances.js";

const database = testDatabase();

/** The stored lease row of `key`. */
const leaseRowOf = async (key: string): Promise<unknown> =>
  (
    await onSchema(
      database.url(),
      `SELECT holder_instance_id, lease_epoch, released, finished FROM agboss_execution_leases
       WHERE root_execution_id = $1`,
      [key],
    )
  ).rows[0];

/**
 * Resolves once B gave the child's lease up — its end of the child (the test's timeout bounds it).
 * Not `finished`: a store whose finish is a plain release must reach the assertions too.
 */
async function untilGivenUp(key: string): Promise<void> {
  const isGivenUp = async () =>
    (
      await onSchema(
        database.url(),
        "SELECT 1 FROM agboss_execution_leases WHERE root_execution_id = $1 AND released",
        [key],
      )
    ).rows.length === 1;
  while (!(await isGivenUp())) await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("AC1 (agbossjs/agboss#520): a frozen instance takes no lease of a child another finished", () => {
  it("AC1: A frozen at its ask for B's child's lease, B answers the child, A thawed — A takes no lease and no takeover is written", async () => {
    const a = await launch(database.url());
    const batch = a.send("execute", {
      workflow: "batch",
      input: [{ name: "on-a" }, { name: "on-b" }],
    }) as Promise<{ status: string; output: { text: string } }>;
    const first = await a.next((event) => event.event === "child-ran");
    const root = String(first.rootExecutionId);
    const tenantId = String(first.tenantId);
    const b = await launch(database.url());
    const onB = await b.next((event) => event.event === "child-ran");
    const child = String(onB.executionId);

    await a.send("hold-acquire", { key: child });
    // A's own child ends: its one step slot is free, so its worker looks at B's running claim
    await a.send("open");
    await a.next(
      (event) => event.event === "end" && event.executionId === String(first.executionId),
    );
    await a.next(
      (event) => event.event === "held" && event.point === "lease.acquire" && event.key === child,
      30_000,
    );
    a.freeze();
    await b.send("open");
    await untilGivenUp(child);
    a.thaw();
    await a.send("let-acquire", { key: child });
    const asked = await a.next((event) => event.event === "acquire-result" && event.key === child);
    const done = await batch;

    // A's ask, sent after B finished the child, got no lease
    expect(asked).toMatchObject({ leaseEpoch: null });
    // the child's lease is still B's claim, finished: nobody took it after B
    expect(await leaseRowOf(child)).toEqual({
      holder_instance_id: b.instanceId,
      lease_epoch: 1,
      released: true,
      finished: true,
    });
    // the lease log has no takeover of the finished child, and no observer heard of one
    const rows = (await b.send("lease-events", {
      tenantId,
      rootExecutionId: root,
    })) as ExecutionLeaseEventRecord[];
    expect(
      rows.filter(
        (row) => row.kind === ExecutionLeaseEventKind.Takeover && row.executionId === child,
      ),
    ).toEqual([]);
    expect(
      [...eventsOf(a, "takeover"), ...eventsOf(b, "takeover")].filter(
        (event) => event.executionId === child,
      ),
    ).toEqual([]);
    // the child ran once, on B, and the batch finished with both jobs
    expect(eventsOf(b, "child-ran").map((event) => event.executionId)).toEqual([child]);
    expect(eventsOf(a, "child-ran").map((event) => event.executionId)).not.toContain(child);
    expect(done.status).toBe("finished");
    expect(done.output.text.split(", ").sort()).toEqual(["on-a", "on-b"]);
  }, 120_000);
});
