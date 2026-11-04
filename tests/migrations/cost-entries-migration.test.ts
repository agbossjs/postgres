import { BudgetScope, type UsageRecord } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresCostLedgerRepository } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#727: migration 0022 on a database migrated to 0021 — the counters written before
 * it keep what they hold, and from then on a save adds an entry with a `ledgerId` once.
 */
const tenantDay = {
  budget: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  key: "acme",
  period: "2026-11-04",
};

const paid = (costUsd: number, ledgerId?: string): UsageRecord => ({
  caller: "action:pay-action",
  model: "pay-api",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
  costSource: "tool",
  ...(ledgerId === undefined ? {} : { isRecordedElsewhere: true, ledgerId }),
});

describe("migration 0022 adds the ledger's entries", () => {
  it("#727: a counter of before keeps its spend; an entry saved twice after it counts once", async () => {
    const url = await freshSchema();
    await migrateWith(
      { url },
      migrationsIn(migrationsFolder({ "0022_cost_ledger_entries.sql": null })),
    );
    await onSchema(
      url,
      `INSERT INTO agboss_cost_counters (budget, scope, scope_key, period, spent_usd)
       VALUES ($1, $2, $3, $4, 1.5)`,
      [tenantDay.budget, tenantDay.scope, tenantDay.key, tenantDay.period],
    );

    const report = await migratePostgres({ url });
    const ledger = new PostgresCostLedgerRepository(connectionTo(url));
    await ledger.saveAll([tenantDay], [paid(0.25, "run-1:pay-action:1#0"), paid(0.5)]);
    await ledger.saveAll([tenantDay], [paid(0.25, "run-1:pay-action:1#0")]);

    expect(report.applied.map((migration) => migration.version)).toEqual([22]);
    expect(await ledger.findSpentByCounter(tenantDay)).toBe(2.25);
  });
});
