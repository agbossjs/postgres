import {
  ComponentKind,
  PauseKind,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "@agboss/core";
import { NO_RECIPIENTS, pauseKeyOf } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { PostgresPausedExecutionRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";
import { pauseOf as approvalOf } from "./pause-fixtures.js";

/** What the contract does not reach: a resolved pause taken, rows that are not readable. */
const database = testDatabase();
const NINE = new Date("2026-01-05T09:00:00.000Z");

const pausesOn = (): PostgresPausedExecutionRepository =>
  new PostgresPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

const pauseOf = (pauseId: string, stepKey: string): PauseRecord => approvalOf(pauseId, stepKey);

/** The pause without its tool call: what a question's record is. */
const withoutToolCall = (pause: PauseRecord): PauseRecord =>
  Object.fromEntries(Object.entries(pause).filter(([key]) => key !== "toolCall")) as PauseRecord;

/** agbossjs/agboss#746: a question role's pause — the role its component, its input the role's DTO. */
const questionPauseOf = (pauseId: string, stepKey: string): PauseRecord => ({
  ...withoutToolCall(pauseOf(pauseId, stepKey)),
  nodeId: "ship-question",
  kind: PauseKind.ExternalTask,
  step: "ship-question",
  target: "ship-external-task",
  channel: "ship-question",
  component: {
    name: "ship-question",
    kind: ComponentKind.ExternalTask,
    promptHash: undefined,
    schemaHash: "ddb0c5dd",
  },
  input: { name: "box-1" },
});

describe("PostgresPausedExecutionRepository", () => {
  it("agbossjs/agboss#746: a question's pause, whose input is no tool call, is read back as written", async () => {
    const pauses = pausesOn();
    const asked = questionPauseOf("p-question", "step-question");

    await pauses.findOrCreateByStepKey(asked);
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-question",
      { decision: { verdict: "yes" }, actor: undefined },
      NINE,
      NO_RECIPIENTS,
    );

    expect(await pauses.findAllByTenantIdAndRootExecutionId("default", "run-1")).toEqual([
      expect.objectContaining({ pauseId: "p-question", input: { name: "box-1" } }),
    ]);
    expect(await pauses.findByTenantIdAndPauseId("default", "p-question")).toMatchObject({
      component: { kind: ComponentKind.ExternalTask },
      status: PauseStatus.Resolved,
      answer: { decision: { verdict: "yes" } },
    });
  });

  it("an approval's pause that lost its tool call still fails loudly when read", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(pauseOf("p-no-call", "step-no-call"));
    await onSchema(
      database.url(),
      `UPDATE agboss_pauses SET record = record #- '{toolCall}' WHERE pause_id = 'p-no-call'`,
    );

    const error: unknown = await pauses.findByTenantIdAndPauseId("default", "p-no-call").then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    const message = error instanceof Error ? error.message : "";
    // #906, #1413 H2: the pause is named by its key (a hash of tenant and id), never by its id, which answers for it
    expect(message).toContain(
      `a stored pause is not readable (pause ${pauseKeyOf("default", "p-no-call")}, `,
    );
    expect(message).not.toContain("p-no-call");
    expect(message).not.toContain("tenantId");
  });

  it("markTaken turns a Resolved pause to Taken, and nothing else", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(pauseOf("p-resolved", "step-resolved"));
    await pauses.findOrCreateByStepKey(pauseOf("p-pending", "step-pending"));
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-resolved",
      { decision: 1, actor: { id: "a" } },
      NINE,
      NO_RECIPIENTS,
    );

    await pauses.markTakenByTenantIdAndPauseId("default", "p-resolved");
    await pauses.markTakenByTenantIdAndPauseId("default", "p-pending");

    expect(await pauses.findByTenantIdAndPauseId("default", "p-resolved")).toMatchObject({
      status: PauseStatus.Taken,
      resolution: PauseResolution.Replied,
      answer: { decision: 1, actor: { id: "a" } },
      resolvedAt: NINE,
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
      { decision: 1, actor: { id: "a" } },
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
      kind: PauseKind.ExternalTask,
      input: { name: "box-1" },
    });
  });

  it("agbossjs/agboss#801: an approval's pause asks a tool call — a question's input under kind approval fails loudly", async () => {
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
