import {
  ComponentKind,
  PauseAnswerer,
  PauseKind,
  PauseResolution,
  questionAskOf,
  PauseStatus,
  type PauseRecord,
} from "@agboss/core";
import { NO_RECIPIENTS } from "@agboss/core/stores";
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
  kind: PauseKind.Approval,
  step: "clerk-agent",
  channel: "refund-approval-channel",
  answerer: PauseAnswerer.Channel,
  ask: { callId: "call-1", tool: "charge", arguments: { text: "10 USD" }, summary: "charge" },
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: "2026-01-05T09:00:00.000Z",
});

/** agbossjs/agboss#746: a question role's pause — the role its component, its ask the role's DTO. */
const questionPauseOf = (pauseId: string, stepKey: string): PauseRecord => ({
  ...pauseOf(pauseId, stepKey),
  nodeId: "ship-question",
  kind: PauseKind.Question,
  step: "ship-question",
  channel: "ship-question",
  component: {
    name: "ship-question",
    kind: ComponentKind.Question,
    promptHash: undefined,
    schemaHash: "ddb0c5dd",
  },
  ask: questionAskOf({ name: "box-1" }),
});

describe("PostgresPausedExecutionRepository", () => {
  it("agbossjs/agboss#746: a question's pause, whose ask is no tool call, is read back as written", async () => {
    const pauses = pausesOn();
    const asked = questionPauseOf("p-question", "step-question");

    await pauses.findOrCreateByStepKey(asked);
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-question",
      { decision: { verdict: "yes" }, answeredBy: undefined },
      NINE,
      NO_RECIPIENTS,
    );

    expect(await pauses.findAllByTenantIdAndRootExecutionId("default", "run-1")).toEqual([
      expect.objectContaining({ pauseId: "p-question", ask: { name: "box-1" } }),
    ]);
    expect(await pauses.findByTenantIdAndPauseId("default", "p-question")).toMatchObject({
      component: { kind: ComponentKind.Question },
      status: PauseStatus.Resolved,
      answer: { decision: { verdict: "yes" } },
    });
  });

  it("an approval's pause whose ask lost its tool call still fails loudly when read", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(pauseOf("p-no-call", "step-no-call"));
    await onSchema(
      database.url(),
      `UPDATE agboss_pauses SET record = record #- '{ask,callId}' WHERE pause_id = 'p-no-call'`,
    );

    const error: unknown = await pauses.findByTenantIdAndPauseId("default", "p-no-call").then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    const message = error instanceof Error ? error.message : "";
    // #906: ids and field paths only, as for a paused run — the tenant is not one of them
    expect(message).toMatch(/a stored pause is not readable \(pauseId p-no-call, /);
    expect(message).not.toContain("tenantId");
  });

  it("markTaken turns a Resolved pause to Taken, and nothing else", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(pauseOf("p-resolved", "step-resolved"));
    await pauses.findOrCreateByStepKey(pauseOf("p-pending", "step-pending"));
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-resolved",
      { decision: 1, answeredBy: "a" },
      NINE,
      NO_RECIPIENTS,
    );

    await pauses.markTakenByTenantIdAndPauseId("default", "p-resolved");
    await pauses.markTakenByTenantIdAndPauseId("default", "p-pending");

    expect(await pauses.findByTenantIdAndPauseId("default", "p-resolved")).toMatchObject({
      status: PauseStatus.Taken,
      resolution: PauseResolution.Replied,
      answer: { decision: 1, answeredBy: "a" },
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
      { decision: 1, answeredBy: "a" },
      NINE,
      NO_RECIPIENTS,
    );
    await pauses.markTakenByTenantIdAndPauseId("default", "p-swept");

    await pauses.deleteByResolvedAtBefore(new Date("2026-01-05T09:00:00.001Z"));

    expect(await pauses.findByTenantIdAndPauseId("default", "p-swept")).toBeUndefined();
  });

  it("agbossjs/agboss#801: a kind is read as written — a question whose component is an agent's stays a question", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(questionPauseOf("p-kept", "step-kept"));
    await onSchema(
      database.url(),
      `UPDATE agboss_pauses SET record = jsonb_set(record, '{component,kind}', '"agent"') WHERE pause_id = 'p-kept'`,
    );

    expect(await pauses.findByTenantIdAndPauseId("default", "p-kept")).toMatchObject({
      kind: PauseKind.Question,
      ask: { name: "box-1" },
    });
  });

  it("agbossjs/agboss#801: an approval's pause asks a tool call — a question's ask under kind approval fails loudly", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(questionPauseOf("p-unkinded", "step-unkinded"));
    await onSchema(
      database.url(),
      `UPDATE agboss_pauses SET record = jsonb_set(record, '{kind}', '"approval"') WHERE pause_id = 'p-unkinded'`,
    );

    await expect(pauses.findByTenantIdAndPauseId("default", "p-unkinded")).rejects.toThrow(
      /a stored pause is not readable/,
    );
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
      /^a stored paused run is not readable: the field\(s\) .*threadId/,
    );
  });
});
