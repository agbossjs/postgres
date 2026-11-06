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
 * agbossjs/agboss#771: migration 0023 on a database at 0022 — an entry held before it is dated
 * "never": no prune removes it, a save of it adds nothing.
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
      migrationsIn(
        migrationsFolder({
          "0022_cost_ledger_entries.sql": null,
          "0023_cost_entries_pruned.sql": null,
          "0024_pause_kind.sql": null,
        }),
      ),
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

    expect(report.applied.map((migration) => migration.version)).toEqual([22, 23, 24]);
    expect(await ledger.findSpentByCounter(tenantDay)).toBe(2.25);
  });
});

describe("migration 0023 dates the ledger's entries", () => {
  it("#771: an entry held before it is never pruned and never counted again", async () => {
    const url = await freshSchema();
    await migrateWith(
      { url },
      migrationsIn(
        migrationsFolder({
          "0023_cost_entries_pruned.sql": null,
          "0024_pause_kind.sql": null,
        }),
      ),
    );
    const before = new PostgresCostLedgerRepository(connectionTo(url));
    await onSchema(url, "INSERT INTO agboss_cost_entries (ledger_id) VALUES ('pass-a:0')", []);

    const report = await migratePostgres({ url });
    await before.deleteEntriesByMadeAtBefore(new Date("2030-01-01T00:00:00.000Z"));
    await before.saveAll(
      [tenantDay],
      [{ ...paid(0.25, "pass-a:0"), madeAt: "2026-11-04T08:00:00.000Z" }],
    );

    expect(report.applied.map((migration) => migration.version)).toEqual([23, 24]);
    expect(await before.findSpentByCounter(tenantDay)).toBe(0);
    const rows = await onSchema(
      url,
      "SELECT made_at = 'infinity' AS never FROM agboss_cost_entries",
    );
    expect(rows.rows).toEqual([{ never: true }]);
  });
});
