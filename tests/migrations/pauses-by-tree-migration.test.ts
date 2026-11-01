import { PauseAnswerer, PauseResolution, PauseStatus, type PauseRecord } from "@agboss/core";
import { TestStoreClock, VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import {
  migratePostgres,
  PostgresExecutionLeaseRepository,
  PostgresPausedExecutionRepository,
} from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { TestApplicationContext } from "../support/application-context.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#663: on a schema of before, a `ParentInstance` child that paused (its refund
 * approved) and sent nothing has no lease row and no outbound call, so 0018 and 0019 kept no id of
 * it; its pause is found by its step key, which names no tree. Migration 0020 keeps every execution
 * that paused, with its tree, and makes the pauses unique per tree and step key: an id minted again
 * is refused, and one the kept ids miss gets a pause of its own, never the old decision.
 */

/** The step key the old child's refund made, and a new execution of that id would make again. */
const STEP_KEY = "old-child-7:child-refund-agent:1:call-1";

/** A pause of `STEP_KEY` in the tree of `rootExecutionId`, pending, as the pause step makes it. */
const pauseOf = (pauseId: string, rootExecutionId: string): PauseRecord => ({
  pauseId,
  tenantId: "acme",
  threadId: "thread-1",
  rootExecutionId,
  executionId: "old-child-7",
  workflow: "refund-one-workflow",
  stepKey: STEP_KEY,
  nodeId: "child-refund-agent",
  visitNumber: 1,
  itemIndex: undefined,
  copyNumber: 1,
  agent: "child-refund-agent",
  channel: "finance-desk-refund-approval-channel",
  answeredBy: PauseAnswerer.Channel,
  ask: { callId: "call-1", tool: "refund-tool", arguments: { orderId: "A" }, summary: "refund A" },
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: "2026-01-05T09:00:00.000Z",
});

/** A schema at 0019 holding the old root's lease and its child's refund pause, approved and taken. */
async function schemaWithAnApprovedChildPause(): Promise<string> {
  const url = await freshSchema();
  await migrateWith({ url }, migrationsIn(migrationsFolder({ "0020_pauses_by_tree.sql": null })));
  // the row as the store of before wrote it: the record as jsonb, its status and resolution time
  const taken = {
    ...pauseOf("old-pause", "old-root"),
    status: PauseStatus.Taken,
    isSent: true,
    answer: { decision: { approved: true }, answerer: "manager-17" },
    resolution: PauseResolution.Replied,
    resolvedAt: "2026-01-05T09:05:00.000Z",
  };
  await onSchema(
    url,
    `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status,
       resolved_at, record) VALUES ('acme', 'old-pause', $1, 'old-root', 'taken', $2, $3::jsonb)`,
    [STEP_KEY, taken.resolvedAt, JSON.stringify(taken)],
  );
  // before #591 the child's id was never kept: only its lease-less pause names it
  await onSchema(url, "DELETE FROM agboss_execution_ids");
  return url;
}

describe("migration 0020 keeps the ids of every execution that paused, and finds a pause in its tree", () => {
  it("#663: the paused child's id and its tree are taken, for any tenant; a new id kept", async () => {
    const url = await schemaWithAnApprovedChildPause();

    const report = await migratePostgres({ url });
    const leases = new PostgresExecutionLeaseRepository(
      connectionTo(url),
      new TestStoreClock(new VirtualClock()),
      new TestApplicationContext({}, "instance-1"),
    );

    expect(report.applied.map((migration) => migration.version)).toEqual([20]);
    const { rows } = await onSchema(
      url,
      "SELECT execution_id, tenant_id FROM agboss_execution_ids ORDER BY execution_id",
    );
    expect(rows).toEqual([
      { execution_id: "old-child-7", tenant_id: "acme" },
      { execution_id: "old-root", tenant_id: "acme" },
    ]);
    for (const executionId of ["old-child-7", "old-root"])
      expect(await leases.saveExecutionIdIfAbsent({ executionId, tenantId: "globex" })).toBe(false);
    expect(await leases.saveExecutionIdIfAbsent({ executionId: "new-1", tenantId: "acme" })).toBe(
      true,
    );
  });

  it("#663: an id the kept ids miss, in another tree: a pending pause of its own — the old approval is never found", async () => {
    const url = await schemaWithAnApprovedChildPause();
    await migratePostgres({ url });
    const pauses = new PostgresPausedExecutionRepository(connectionTo(url), new VirtualClock());

    const made = await pauses.findOrCreateByStepKey(pauseOf("new-pause", "new-root"));
    const again = await pauses.findOrCreateByStepKey(pauseOf("third-pause", "new-root"));
    const old = await pauses.findOrCreateByStepKey(pauseOf("fourth-pause", "old-root"));

    expect(made).toEqual(pauseOf("new-pause", "new-root"));
    expect(again.pauseId).toBe("new-pause");
    expect(old).toMatchObject({ pauseId: "old-pause", status: PauseStatus.Taken });
    const { rows } = await onSchema(
      url,
      "SELECT pause_id, root_execution_id, status FROM agboss_pauses ORDER BY seq",
    );
    expect(rows).toEqual([
      { pause_id: "old-pause", root_execution_id: "old-root", status: "taken" },
      { pause_id: "new-pause", root_execution_id: "new-root", status: "pending" },
    ]);
  });
  it("#663: an id of before holding U+E000 is kept as minted, not as the record escaped it (0013) — a pause's, and an outbound call's that 0019 kept escaped", async () => {
    const url = await freshSchema();
    await migrateWith({ url }, migrationsIn(migrationsFolder({ "0020_pauses_by_tree.sql": null })));
    const childId = "old\uE000child";
    const record = { ...pauseOf("odd-pause", "old-root"), executionId: "old\uE000\uE000child" };
    await onSchema(
      url,
      `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status, record)
       VALUES ('acme', 'odd-pause', $1, 'old-root', 'pending', $2::jsonb)`,
      [`${childId}:child-refund-agent:1:call-1`, JSON.stringify(record)],
    );

    // and (0019 kept it escaped) an outbound call's child holding one
    await onSchema(
      url,
      `INSERT INTO agboss_outbound_calls (scope_key, idempotency_key, name, tenant_id,
         root_execution_id, status, attempt, attempt_owner, record)
       VALUES ('acme:old-root', 'k', 'pay', 'acme', 'old-root', 'completed', 1, 'owner-1',
         jsonb_build_object('executionId', $1::text))`,
      ["old\uE000\uE000payer"],
    );

    await migratePostgres({ url });
    const leases = new PostgresExecutionLeaseRepository(
      connectionTo(url),
      new TestStoreClock(new VirtualClock()),
      new TestApplicationContext({}, "instance-1"),
    );

    for (const executionId of [childId, "old\uE000payer"])
      expect(await leases.saveExecutionIdIfAbsent({ executionId, tenantId: "acme" })).toBe(false);
  });
});
