/**
 * AC3 (agbossjs/agboss#482): a pause made on instance A — its own `node` process — is resumed on
 * instance B, another process on the same PostgreSQL: the pause, the checkpoint and the thread
 * are in the database, nothing in A's memory is needed. The approved tool runs on B, once; a
 * second answer to the same pause is refused on either instance.
 */
import { describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { eventsOf, launch } from "./instances.js";

const database = testDatabase();

interface Output {
  readonly status: string;
  readonly executionId: string;
  readonly output?: { readonly name: string; readonly by: string };
  readonly pending: readonly { readonly pauseId: string; readonly channel: string }[];
}

describe("AC3: a pause across two processes", () => {
  it("AC3: a pause made on A is resumed on B", async () => {
    const a = await launch(database.url());
    const b = await launch(database.url());

    const paused = (await a.send("execute", {
      workflow: "approval",
      input: { name: "order-9" },
    })) as Output;

    expect(paused.status).toBe("paused");
    expect(paused.pending).toEqual([
      { pauseId: expect.any(String), channel: "ship-approval-channel" },
    ]);
    expect(eventsOf(a, "shipped")).toEqual([]);
    const pauseId = paused.pending[0]?.pauseId;

    const done = (await b.send("resume", { pauseId, decision: { approved: true } })) as Output;

    expect(done).toMatchObject({
      status: "finished",
      executionId: paused.executionId,
      output: { name: "order-9", by: b.instanceId },
      pending: [],
    });
    expect(eventsOf(b, "shipped")).toEqual([
      expect.objectContaining({ name: "order-9", instanceId: b.instanceId }),
    ]);
    expect(eventsOf(a, "shipped")).toEqual([]);
    expect(eventsOf(b, "end")).toEqual([
      expect.objectContaining({ executionId: paused.executionId }),
    ]);
    // the pause was answered once: a second answer, on A or on B, is refused
    for (const instance of [a, b])
      await expect(
        instance.send("resume", { pauseId, decision: { approved: true } }),
      ).rejects.toThrow();
    expect([...eventsOf(a, "shipped"), ...eventsOf(b, "shipped")]).toHaveLength(1);
  }, 120_000);
});
