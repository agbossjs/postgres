/**
 * agbossjs/agboss#777 AC1: an instance that is up and idle — its sweep at the start found the queue
 * empty — claims a child another process queues as soon as it is queued, woken by the queue's
 * `NOTIFY`, not at its next sweep 30 s after its start. B starts first; then A queues two
 * children with one step slot: A runs one, and B must claim the other long before its next sweep
 * (this test's timeout, 20 s, is below it — before #777 B idled until then and the test timed out).
 */
import { describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { eventsOf, launch } from "./instances.js";

const database = testDatabase();

describe("agbossjs/agboss#777 AC1: a child queued in another process wakes an idle instance", () => {
  it("B, idle since its start, claims the child A queued before its next sweep", async () => {
    const b = await launch(database.url());
    const a = await launch(database.url());
    const batch = a.send("execute", {
      workflow: "batch",
      input: [{ name: "x" }, { name: "y" }],
    }) as Promise<{ status: string; output: { text: string } }>;

    const onB = await b.next((event) => event.event === "child-ran");
    const onA = await a.next((event) => event.event === "child-ran");

    expect(onB.instanceId).toBe(b.instanceId);
    expect([onA.name, onB.name].sort()).toEqual(["x", "y"]);
    await Promise.all([a.send("open"), b.send("open")]);
    const done = await batch;
    expect(done.status).toBe("finished");
    expect(done.output.text.split(", ").sort()).toEqual(["x", "y"]);
    expect([...eventsOf(a, "child-ran"), ...eventsOf(b, "child-ran")]).toHaveLength(2);
  }, 20_000);
});
