import { BudgetScope, CostSource, type LedgerEntry } from "@agboss/core";
import { usd } from "@agboss/core/units";
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

/** An entry of the ledger (agbossjs/agboss#817: every save is of entries). */
const paid = (
  costUsd: number,
  ledgerId: string,
  madeAt = new Date("2026-11-04T12:00:00.000Z"),
): LedgerEntry => ({
  caller: "action:pay-action",
  model: "pay-api",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: usd(costUsd),
  costSource: CostSource.Tool,
  ledgerId,
  madeAt,
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
          "0025_records_by_run.sql": null,
          "0026_a2a_tasks.sql": null,
          "0027_outbound_call_outcome_names.sql": null,
          "0028_a2a_task_mesh_body_hash.sql": null,
          "0029_execution_lease_token.sql": null,
          "0030_a2a_direct_messages.sql": null,
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
    await ledger.saveAll(
      [tenantDay],
      [paid(0.25, "run-1:pay-action:1#0"), paid(0.5, "run-1:pay-action:2#0")],
    );
    await ledger.saveAll([tenantDay], [paid(0.25, "run-1:pay-action:1#0")]);

    expect(report.applied.map((migration) => migration.version)).toEqual([
      22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
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
          "0025_records_by_run.sql": null,
          "0026_a2a_tasks.sql": null,
          "0027_outbound_call_outcome_names.sql": null,
          "0028_a2a_task_mesh_body_hash.sql": null,
          "0029_execution_lease_token.sql": null,
          "0030_a2a_direct_messages.sql": null,
        }),
      ),
    );
    const before = new PostgresCostLedgerRepository(connectionTo(url));
    await onSchema(url, "INSERT INTO agboss_cost_entries (ledger_id) VALUES ('pass-a:0')", []);

    const report = await migratePostgres({ url });
    await before.deleteByMadeAtBefore(new Date("2030-01-01T00:00:00.000Z"));
    await before.saveAll(
      [tenantDay],
      [paid(0.25, "pass-a:0", new Date("2026-11-04T08:00:00.000Z"))],
    );

    expect(report.applied.map((migration) => migration.version)).toEqual([
      23, 24, 25, 26, 27, 28, 29, 30,
    ]);
    expect(await before.findSpentByCounter(tenantDay)).toBe(0);
    const rows = await onSchema(
      url,
      "SELECT made_at = 'infinity' AS never FROM agboss_cost_entries",
    );
    expect(rows.rows).toEqual([{ never: true }]);
  });
});
