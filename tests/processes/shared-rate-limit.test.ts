/**
 * AC2 (agbossjs/agboss#483): a provider's `maxConcurrentCalls: 1` holds across two processes on
 * PostgreSQL. A and B each run two executions at once against the limited provider, which holds
 * each call 300 ms and tells the test when it started and ended on the `Clock`: the four calls
 * never overlap — each starts after the one before it ended, whichever process made either —
 * and both processes made calls. With a slot per process, A's and B's calls would overlap.
 */
import { describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { eventsOf, launch, type Instance } from "./instances.js";

const database = testDatabase();

/** One call to the limited provider: when it started and ended, on which instance. */
interface Call {
  readonly instanceId: string;
  readonly start: number;
  readonly end: number;
}

/** The calls an instance made, from its `limited-call` events (a start, then its end). */
function callsOf(instance: Instance): Call[] {
  const events = eventsOf(instance, "limited-call");
  const starts = events.filter((event) => event.phase === "start");
  const ends = events.filter((event) => event.phase === "end");
  return starts.map((started, index) => ({
    instanceId: instance.instanceId,
    start: Number(started.at),
    end: Number(ends[index]?.at),
  }));
}

const limited = (name: string) => ({ workflow: "limited", input: { name } });

describe("AC2: a provider rate limit across two processes", () => {
  it("AC2: maxConcurrentCalls: 1 across two processes is never exceeded", async () => {
    const a = await launch(database.url());
    const b = await launch(database.url());

    const outputs = await Promise.all([
      a.send("execute", limited("a-1")),
      b.send("execute", limited("b-1")),
      a.send("execute", limited("a-2")),
      b.send("execute", limited("b-2")),
    ]);

    expect(outputs).toEqual([
      expect.objectContaining({ status: "finished", output: { name: "a-1", by: a.instanceId } }),
      expect.objectContaining({ status: "finished", output: { name: "b-1", by: b.instanceId } }),
      expect.objectContaining({ status: "finished", output: { name: "a-2", by: a.instanceId } }),
      expect.objectContaining({ status: "finished", output: { name: "b-2", by: b.instanceId } }),
    ]);
    const calls = [...callsOf(a), ...callsOf(b)].sort((left, right) => left.start - right.start);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((call) => call.instanceId))).toEqual(
      new Set([a.instanceId, b.instanceId]),
    );
    for (const [index, call] of calls.entries()) {
      expect(call.end - call.start).toBeGreaterThanOrEqual(300);
      const before = calls[index - 1];
      if (before !== undefined) expect(call.start).toBeGreaterThanOrEqual(before.end);
    }
  }, 120_000);
});
