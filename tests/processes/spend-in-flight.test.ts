/**
 * agbossjs/agboss#727 — a tree's spend in flight, seen by its own children on the other process.
 * Two `node` processes on one PostgreSQL, one step slot each; the execution may spend $1. A's
 * child pays $0.60 and waits at A's gate; B, started then, claims the other child, which pays its
 * $0.60 (the ledger held A's $0.60 by then: $0.60 of $1) and waits at B's gate. When B's gate
 * opens, that child's next step is held back at $1.20: A's child's spend was in the ledger the
 * moment it was made, though its step never ended. Before #727 it reached the ledger only at the
 * end of its superstep, so B's child paid twice more and finished at $1.50 — the tree $1.80.
 */
import { describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { eventsOf, launch } from "./instances.js";

const database = testDatabase();

describe("agbossjs/agboss#727: a sibling child's spend on the other process", () => {
  it("the child on B is held back at $1.20 while the child on A holds its $0.60", async () => {
    const a = await launch(database.url());
    const run = a.send("execute", {
      workflow: "pay-items",
      input: [{ name: "x" }, { name: "y" }],
      tenantId: "inflight",
    });
    run.catch(() => undefined);
    const first = await a.next((event) => event.event === "paying");
    const b = await launch(database.url());
    const second = await b.next((event) => event.event === "paying");
    expect(second.name).not.toBe(first.name);

    await b.send("open");

    await expect(run).rejects.toMatchObject({
      name: "BudgetExceededError",
      message: expect.stringMatching(/spent \$1\.2;/),
    });
    // neither child paid past its first step: the one on B was held back at once
    expect(eventsOf(b, "paid-step")).toEqual([]);
    expect(eventsOf(a, "paid-step")).toEqual([]);
  }, 120_000);
});
