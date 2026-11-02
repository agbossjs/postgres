import { ComponentKind, PauseAnswerer, PauseResolution } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { migratePostgres } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import type { PauseAnswer } from "../../src/stores/records/record-rows.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { recordsOn } from "../support/stores.js";

/**
 * agbossjs/agboss#676: the pause answer log behind `record.pauses` kept one answer per tenant and
 * step key, and a step key names no tree: since #663 another tree's pause under the same key (an
 * id minted again that the kept ids miss) is asked again, but its answer was dropped. Migration
 * 0021 keys the log by tenant, root execution and step key, every row and its order kept.
 */

const STEP_KEY = "old-child-7:child-refund-agent:1:call-1";

const answerOf = (responder: string, askedAt: string): PauseAnswer => ({
  pauseId: undefined,
  executionId: "old-child-7",
  step: {
    component: {
      name: "child-refund-agent",
      kind: ComponentKind.Agent,
      promptHash: undefined,
      schemaHash: undefined,
    },
    nodeId: "child-refund-agent",
    visitNumber: 1,
    idempotencyKey: STEP_KEY,
    callId: "call-1",
    itemIndex: undefined,
    copyNumber: 1,
    toolLoopIteration: 1,
    validationAttempts: 0,
  },
  role: "finance-desk-refund-approval-channel",
  answeredBy: PauseAnswerer.Channel,
  responder,
  resolution: PauseResolution.Replied,
  askedAt,
  resolvedAt: askedAt,
  decision: { approved: true },
});

const respondersOf = async (
  records: ReturnType<typeof recordsOn>,
  root: string,
): Promise<unknown[]> =>
  (await records.findPauseAnswersByTenantIdAndRootExecutionId("acme", root)).map(
    (answer) => answer.responder,
  );

describe("migration 0021 keeps one pause answer per pause of a tree", () => {
  it("#676: on a schema at 0020 with answers, another tree's answer under the same step key is kept", async () => {
    const url = await freshSchema();
    await migrateWith(
      { url },
      migrationsIn(migrationsFolder({ "0021_pause_answers_by_tree.sql": null })),
    );
    // the rows as the store of before wrote them: one per tenant and step key
    for (const [key, responder] of [
      [STEP_KEY, "manager-17"],
      [`${STEP_KEY}0`, "manager-18"],
    ] as const)
      await onSchema(
        url,
        `INSERT INTO agboss_pause_answers (tenant_id, root_execution_id, step_key, asked_at, record)
         VALUES ('acme', 'old-root', $1, '2026-01-05T09:00:00.000Z', $2)`,
        [
          key,
          JSON.stringify({
            ...answerOf(responder, "2026-01-05T09:00:00.000Z"),
            step: { ...answerOf("", "").step, idempotencyKey: key },
          }),
        ],
      );

    const report = await migratePostgres({ url });
    const records = recordsOn(url);
    await records.savePauseAnswer(
      "acme",
      "new-root",
      answerOf("manager-21", "2026-02-01T09:00:00.000Z"),
    );
    await records.savePauseAnswer(
      "acme",
      "old-root",
      answerOf("manager-99", "2026-02-01T09:00:00.000Z"),
    );

    expect(report.applied.map((migration) => migration.version)).toEqual([21]);
    expect(await respondersOf(records, "old-root")).toEqual(["manager-17", "manager-18"]);
    expect(await respondersOf(records, "new-root")).toEqual(["manager-21"]);
    const { rows } = await onSchema(
      url,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'agboss_pause_answers'::regclass AND contype = 'p'`,
    );
    expect(rows).toEqual([{ def: "PRIMARY KEY (tenant_id, root_execution_id, step_key)" }]);
  });
});
