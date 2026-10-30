/**
 * AC1 (agbossjs/agboss#482): two application instances, each its own `node` process with its own
 * pool and no shared disk, on one PostgreSQL. A is killed (SIGKILL) in the middle of a run; B,
 * started afterwards, takes the tree over once A's lease ran out and finishes it from its last
 * checkpoint — and the lease log (`app.leaseEventsOf`) names A as the holder it took over from.
 * The real `Clock` and the core's fixed 30 s lease (Q58: not a setting): B's sweep at its start
 * finds the lease still held, the next one, a lease length later, takes it — about 30 s. No real
 * duration is asserted (agbossjs/agboss#523): that B took an expired lease, not a held one, is the
 * lease log's (the previous holder and token) and the lease contract suite's (a held lease is
 * never taken); "never hangs" is the wait's own bound, 75 s.
 */
import {
  ExecutionLeaseEventKind,
  LeaseTakeoverReason,
  type ExecutionLeaseEventRecord,
} from "@agboss/core";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { eventsOf, launch } from "./instances.js";

const database = testDatabase();

describe("AC1: a tree whose process was killed is taken over by another process", () => {
  it("AC1: B finishes the tree A was killed in; the lease log names A as the previous holder", async () => {
    const a = await launch(database.url());
    void a.send("execute", { workflow: "takeover", input: { name: "order-7" } });
    const holding = await a.next((event) => event.event === "holding");
    const root = String(holding.rootExecutionId);
    const tenantId = String(holding.tenantId);

    expect(await a.kill()).toBe("SIGKILL");
    const killedAt = Date.now();
    const b = await launch(database.url(), { gate: "open" });
    const end = await b.next(
      (event) => event.event === "end" && event.executionId === root,
      75_000,
    );

    expect(end).toMatchObject({ rootExecutionId: root, finish: "takeover-workflow-finish" });
    // the finished step is not repeated; the step A was killed in runs again, on B
    expect(eventsOf(a, "prepared")).toHaveLength(1);
    expect(eventsOf(b, "prepared")).toEqual([]);
    expect(eventsOf(a, "holding")).toEqual([expect.objectContaining({ instanceId: a.instanceId })]);
    expect(eventsOf(b, "holding")).toEqual([
      expect.objectContaining({ instanceId: b.instanceId, rootExecutionId: root }),
    ]);
    // the schema is this file's own: its one record is no longer running, so no sweep takes it again
    const records = await onSchema(database.url(), "SELECT status FROM agboss_execution_records");
    expect(records.rows).toHaveLength(1);
    expect(records.rows[0]).not.toEqual({ status: "running" });

    const rows = (await b.send("lease-events", {
      tenantId,
      rootExecutionId: root,
    })) as ExecutionLeaseEventRecord[];

    const takeovers = rows.filter((row) => row.kind === ExecutionLeaseEventKind.Takeover);
    expect(takeovers).toEqual([
      expect.objectContaining({
        tenantId,
        rootExecutionId: root,
        executionId: root,
        reason: LeaseTakeoverReason.Recovered,
        holderInstanceId: b.instanceId,
        previousHolderInstanceId: a.instanceId,
      }),
    ]);
    const [takeover] = takeovers;
    // B took the tree over after A was killed: an order of two moments, never a duration
    expect(Date.parse(takeover?.occurredAt ?? "")).toBeGreaterThanOrEqual(killedAt);
    expect(takeover?.kind === ExecutionLeaseEventKind.Takeover && takeover.previousToken).toBe(
      (takeover?.token ?? 0) - 1,
    );
    // the observer heard of it too, after the row was written
    expect(eventsOf(b, "takeover")).toEqual([
      expect.objectContaining({
        previousHolderInstanceId: a.instanceId,
        holderInstanceId: b.instanceId,
      }),
    ]);
    // A, killed, wrote nothing more: SIGKILL runs no code, not even a hand-over
    expect(rows.filter((row) => row.holderInstanceId === a.instanceId)).toEqual([]);
  }, 120_000);
});
