import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { PostgresPausedExecutionRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";
import { pausedRun } from "./stored-rows.fixtures.js";

/**
 * The tenant and the thread of a paused run's statements (agbossjs/agboss#1302): runs of tenants
 * that share their thread ids never touch each other. Dropping a predicate from a statement, one at
 * a time, fails one of these.
 */
const database = testDatabase();

const pausesOn = (): PostgresPausedExecutionRepository =>
  new PostgresPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

/** The runs stored: `[tenant, thread]` each under run `run-1`, written as the store of 0.1.1 writes them. */
async function stored(...runs: readonly (readonly [string, string])[]): Promise<void> {
  await onSchema(database.url(), "DELETE FROM agboss_paused_executions");
  for (const [tenantId, threadId] of runs)
    await onSchema(
      database.url(),
      "INSERT INTO agboss_paused_executions VALUES ($1, $2, 'run-1', $3, '1.0.0', 'hash', now())",
      [tenantId, threadId, JSON.stringify({ ...pausedRun, tenantId, threadId, runId: "run-1" })],
    );
}

const keysStored = async (): Promise<string[]> =>
  (
    await onSchema(
      database.url(),
      "SELECT tenant_id || '/' || thread_id AS key FROM agboss_paused_executions ORDER BY 1",
    )
  ).rows.map((row: { key: string }) => row.key);

describe("the paused runs of tenants that share their thread ids", () => {
  it("a run is found by its tenant and its thread", async () => {
    await stored(["tenant-a", "thread-1"]);

    expect(await pausesOn().findByTenantIdAndThreadId("tenant-b", "thread-1")).toBeUndefined();
    expect(await pausesOn().findByTenantIdAndThreadId("tenant-a", "thread-1")).toBeDefined();
  });

  it("deleted by thread: its tenant's one thread only", async () => {
    await stored(["tenant-a", "thread-1"], ["tenant-b", "thread-1"], ["tenant-a", "thread-2"]);

    await pausesOn().deleteByTenantIdAndThreadId("tenant-a", "thread-1");

    expect(await keysStored()).toEqual(["tenant-a/thread-2", "tenant-b/thread-1"]);
  });

  it("deleted by run: its tenant's one thread only", async () => {
    await stored(["tenant-a", "thread-1"], ["tenant-b", "thread-1"], ["tenant-a", "thread-2"]);

    await pausesOn().deleteByTenantIdAndThreadIdAndRunId("tenant-a", "thread-1", "run-1");

    expect(await keysStored()).toEqual(["tenant-a/thread-2", "tenant-b/thread-1"]);
  });
});
