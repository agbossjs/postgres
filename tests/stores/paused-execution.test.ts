import { PauseAnswerer, PauseResolution, PauseStatus, type PauseRecord } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { PostgresPausedExecutionRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/** What the contract does not reach: a resolved pause taken, rows that are not readable. */
const database = testDatabase();
const NINE = new Date("2026-01-05T09:00:00.000Z");

const pausesOn = (): PostgresPausedExecutionRepository =>
  new PostgresPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

const pauseOf = (pauseId: string, stepKey: string): PauseRecord => ({
  pauseId,
  tenantId: "default",
  threadId: "thread-1",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "order-workflow",
  stepKey,
  nodeId: "clerk-agent",
  visitNumber: 1,
  itemIndex: undefined,
  copyNumber: 1,
  agent: "clerk-agent",
  channel: "refund-approval-channel",
  answeredBy: PauseAnswerer.Channel,
  ask: { callId: "call-1", tool: "charge", arguments: { text: "10 USD" }, summary: "charge" },
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: "2026-01-05T09:00:00.000Z",
});

describe("PostgresPausedExecutionRepository", () => {
  it("markTaken turns a Resolved pause to Taken, and nothing else", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(pauseOf("p-resolved", "step-resolved"));
    await pauses.findOrCreateByStepKey(pauseOf("p-pending", "step-pending"));
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-resolved",
      { decision: 1, answerer: "a" },
      NINE,
    );

    await pauses.markTakenByTenantIdAndPauseId("default", "p-resolved");
    await pauses.markTakenByTenantIdAndPauseId("default", "p-pending");

    expect(await pauses.findByTenantIdAndPauseId("default", "p-resolved")).toMatchObject({
      status: PauseStatus.Taken,
      resolution: PauseResolution.Replied,
      answer: { decision: 1, answerer: "a" },
      resolvedAt: NINE.toISOString(),
    });
    expect((await pauses.findByTenantIdAndPauseId("default", "p-pending"))?.status).toBe(
      PauseStatus.Pending,
    );
    const { rows } = await onSchema(
      database.url(),
      "SELECT status FROM agboss_pauses WHERE pause_id = 'p-resolved'",
    );
    expect(rows).toEqual([{ status: "taken" }]);
  });

  it("a taken pause is removed by the sweep once resolved before the cutoff", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(pauseOf("p-swept", "step-swept"));
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-swept",
      { decision: 1, answerer: "a" },
      NINE,
    );
    await pauses.markTakenByTenantIdAndPauseId("default", "p-swept");

    await pauses.deleteResolvedBefore(new Date("2026-01-05T09:00:00.001Z"));

    expect(await pauses.findByTenantIdAndPauseId("default", "p-swept")).toBeUndefined();
  });

  it("a pause row that is not one fails loudly when read", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(pauseOf("p-bad", "step-bad"));
    await onSchema(
      database.url(),
      `UPDATE agboss_pauses SET record = jsonb_set(record, '{status}', '"unknown"') WHERE pause_id = 'p-bad'`,
    );

    await expect(pauses.findByTenantIdAndPauseId("default", "p-bad")).rejects.toThrow(
      /a stored pause is not readable/,
    );
  });

  it("a paused run that is not one fails loudly when read", async () => {
    const pauses = pausesOn();
    await onSchema(
      database.url(),
      `INSERT INTO agboss_paused_executions VALUES ('default', 'thread-bad', 'run-1', '{"status":"answered"}', '1.0.0', 'hash', now())`,
    );

    await expect(pauses.findByTenantIdAndThreadId("default", "thread-bad")).rejects.toThrow(
      'a stored paused run is not readable: {"status":"answered"}',
    );
  });
});
