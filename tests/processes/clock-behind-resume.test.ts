/**
 * agbossjs/agboss#682 on PostgreSQL, across processes: a pause made on instance A, whose clock runs
 * an hour ahead of B's, is resumed on B. LangGraph names every checkpoint by a UUIDv6 of the
 * process's `Date.now()` and `PostgresSaver`'s latest checkpoint is the greatest id, so B's
 * checkpoints sort before A's: read as the greatest id, the tree's latest after B's resume was still
 * A's paused one. The core's checkpointer marks the thread at B's first out-of-order write and reads
 * it by LangGraph's step: the resume finishes on B, the tool runs once, and a later read of the tree
 * (a second answer, the history) sees it finished.
 */
import { describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { eventsOf, launch } from "./instances.js";

const database = testDatabase();

/** An hour: A's clock ahead of B's (the host's). */
const HOUR = 3_600_000;

interface Output {
  readonly status: string;
  readonly executionId: string;
  readonly output?: { readonly name: string; readonly by: string };
  readonly pending: readonly { readonly pauseId: string; readonly channel: string }[];
}

describe("agbossjs/agboss#682: a resume on an instance whose clock is behind", () => {
  it("a pause made on A, an hour ahead, is resumed on B: finished, the tool run once", async () => {
    const a = await launch(database.url(), { clock: { offsetMs: HOUR } });
    const b = await launch(database.url());

    const paused = (await a.send("execute", {
      workflow: "approval",
      input: { name: "order-682" },
    })) as Output;
    expect(paused.status).toBe("paused");
    const pauseId = paused.pending[0]?.pauseId;

    const done = (await b.send("resume", { pauseId, decision: { approved: true } })) as Output;

    expect(done).toMatchObject({
      status: "finished",
      executionId: paused.executionId,
      output: { name: "order-682", by: b.instanceId },
      pending: [],
    });
    expect([...eventsOf(a, "shipped"), ...eventsOf(b, "shipped")]).toHaveLength(1);
    for (const instance of [a, b])
      await expect(
        instance.send("resume", { pauseId, decision: { approved: true } }),
      ).rejects.toThrow();
  }, 120_000);

  it("two pauses: the first made on A, an hour ahead, both answered on B — each tool run once", async () => {
    const a = await launch(database.url(), { clock: { offsetMs: HOUR } });
    const b = await launch(database.url());

    const first = (await a.send("execute", {
      workflow: "two-approvals",
      input: { name: "order-682b" },
    })) as Output;
    expect(first.status).toBe("paused");
    const second = (await b.send("resume", {
      pauseId: first.pending[0]?.pauseId,
      decision: { approved: true },
    })) as Output;
    expect(second.status).toBe("paused");
    // B's checkpoints sort before A's: the second resume continues from B's, not A's paused one
    const done = (await b.send("resume", {
      pauseId: second.pending[0]?.pauseId,
      decision: { approved: true },
    })) as Output;

    expect(done).toMatchObject({ status: "finished", output: { name: "order-682b" }, pending: [] });
    expect([...eventsOf(a, "shipped"), ...eventsOf(b, "shipped")]).toHaveLength(2);
  }, 120_000);
});
