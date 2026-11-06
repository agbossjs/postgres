import { PauseKind, PauseStatus } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresPausedExecutionRepository } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#801: migration 0024 on a database at 0023 — a pause record written before kept
 * `agent` and no `kind` (the store told a question by its component). Each row is rewritten by
 * that rule once: a question role's component → `question`, an agent's or none → `approval`,
 * `agent` → `step`; the store then reads `kind` as written.
 */
const APPROVAL_ASK = {
  callId: "call-1",
  tool: "refund-tool",
  arguments: { orderId: "A" },
  summary: "r",
};

/** A record as the store of before wrote it. */
const recordOf = (pauseId: string, fields: Record<string, unknown>): Record<string, unknown> => ({
  pauseId,
  tenantId: "acme",
  threadId: "thread-1",
  rootExecutionId: "root-1",
  executionId: "root-1",
  workflow: "refund-workflow",
  stepKey: `root-1:${pauseId}`,
  visitNumber: 1,
  copyNumber: 1,
  channel: "finance-desk-channel",
  answeredBy: "channel",
  status: PauseStatus.Pending,
  isSent: true,
  askedAt: "2026-01-05T09:00:00.000Z",
  ...fields,
});

const OLD_ROWS = [
  recordOf("approval-pause", {
    nodeId: "refund-agent",
    agent: "refund-agent",
    component: { name: "refund-agent", kind: "agent" },
    ask: APPROVAL_ASK,
  }),
  recordOf("question-pause", {
    nodeId: "spending-limit-question",
    agent: "spending-limit-question",
    component: { name: "spending-limit-question", kind: "question" },
    ask: { item: "laptop", priceUsd: 1200 },
  }),
  recordOf("bare-pause", { nodeId: "refund-agent", agent: "refund-agent", ask: APPROVAL_ASK }),
];

/** A schema at 0023 holding the rows of before. */
async function schemaWithOldPauses(): Promise<string> {
  const url = await freshSchema();
  await migrateWith(
    { url },
    migrationsIn(
      migrationsFolder({ "0024_pause_kind.sql": null, "0025_records_by_run.sql": null }),
    ),
  );
  for (const record of OLD_ROWS)
    await onSchema(
      url,
      `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status, record)
       VALUES ('acme', $1, $2, 'root-1', 'pending', $3::jsonb)`,
      [record.pauseId, record.stepKey, JSON.stringify(record)],
    );
  return url;
}

describe("migration 0024 stores each pause's kind and names its step", () => {
  it("#801: an approval, a question and a pause from before components read their kind and step", async () => {
    const url = await schemaWithOldPauses();

    const report = await migratePostgres({ url });
    const pauses = new PostgresPausedExecutionRepository(connectionTo(url), new VirtualClock());

    expect(report.applied.map((migration) => migration.version)).toEqual([24, 25]);
    expect(await pauses.findByTenantIdAndPauseId("acme", "approval-pause")).toMatchObject({
      kind: PauseKind.Approval,
      step: "refund-agent",
      ask: APPROVAL_ASK,
    });
    expect(await pauses.findByTenantIdAndPauseId("acme", "question-pause")).toMatchObject({
      kind: PauseKind.Question,
      step: "spending-limit-question",
      ask: { item: "laptop", priceUsd: 1200 },
    });
    expect(await pauses.findByTenantIdAndPauseId("acme", "bare-pause")).toMatchObject({
      kind: PauseKind.Approval,
      step: "refund-agent",
    });
    const { rows } = await onSchema(
      url,
      `SELECT pause_id, record->>'kind' AS kind, record->>'step' AS step, record ? 'agent' AS has_agent
       FROM agboss_pauses ORDER BY pause_id`,
    );
    expect(rows).toEqual([
      { pause_id: "approval-pause", kind: "approval", step: "refund-agent", has_agent: false },
      { pause_id: "bare-pause", kind: "approval", step: "refund-agent", has_agent: false },
      {
        pause_id: "question-pause",
        kind: "question",
        step: "spending-limit-question",
        has_agent: false,
      },
    ]);
  });

  it("#801: a row of before is refused unread without the migration — the store never infers a kind", async () => {
    const url = await schemaWithOldPauses();
    const pauses = new PostgresPausedExecutionRepository(connectionTo(url), new VirtualClock());

    await expect(pauses.findByTenantIdAndPauseId("acme", "question-pause")).rejects.toThrow(
      /a stored pause is not readable/,
    );
  });
});
