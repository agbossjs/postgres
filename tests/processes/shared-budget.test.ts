/**
 * AC1 (agbossjs/agboss#483): two processes share one tenant's daily budget in PostgreSQL. Each
 * spends through a scripted transport provider of a fixed cost ($5 a call, the day allows $10):
 * A's call and B's call both count toward the tenant's day, and the next call — on whichever
 * process makes it — is refused with `BudgetExceededError` before it reaches the provider. With a
 * ledger per process each would still have $5 left. Another tenant's day is untouched.
 */
import { describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { eventsOf, launch } from "./instances.js";

const database = testDatabase();

const spend = (name: string, tenantId: string) => ({
  workflow: "spend",
  input: { name },
  tenantId,
});

const REFUSED = {
  name: "BudgetExceededError",
  message: expect.stringMatching(/tenant acme spent \$10 today; process-tenant-budget allows \$10/),
};

describe("AC1: a tenant's daily budget across two processes", () => {
  it("AC1: spend from both counts toward it, and the call that would exceed it is refused", async () => {
    const a = await launch(database.url());
    const b = await launch(database.url());

    const onA = await a.send("execute", spend("job-a", "acme"));
    const onB = await b.send("execute", spend("job-b", "acme"));

    expect(onA).toMatchObject({ status: "finished", output: { name: "job-a", by: a.instanceId } });
    expect(onB).toMatchObject({ status: "finished", output: { name: "job-b", by: b.instanceId } });
    // $5 on A + $5 on B: the day is spent on both — refused before any call, on either process
    await expect(a.send("execute", spend("job-c", "acme"))).rejects.toMatchObject(REFUSED);
    await expect(b.send("execute", spend("job-d", "acme"))).rejects.toMatchObject(REFUSED);
    expect(eventsOf(a, "priced-call")).toHaveLength(1);
    expect(eventsOf(b, "priced-call")).toHaveLength(1);
    // the budget is the tenant's: another tenant still spends
    expect(await a.send("execute", spend("job-e", "globex"))).toMatchObject({
      status: "finished",
      tenantId: "globex",
    });
  }, 120_000);
});
