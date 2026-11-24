import { BudgetScope, CostSource, type CostCounter, type LedgerEntry } from "@agboss/core";
import { usd } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresCostLedgerRepository } from "../../src/index.js";
import { freshSchema, onSchema } from "../support/database.js";
import { connectionTo } from "../support/stores.js";
import { blockedBefore, openTransaction, pidOf } from "./pause-locks.js";

/**
 * Each clause of the ledger's save a test proves (agbossjs/agboss#1302): dropping it from the
 * statement, one at a time, fails one of these. A schema of its own per test: the pruning mark is
 * the schema's one row.
 */
const MARK = new Date("2026-10-18T12:00:00.000Z");
const BEFORE = new Date("2026-10-18T11:00:00.000Z");
const AFTER = new Date("2026-10-18T13:00:00.000Z");

const entry = (ledgerId: string, madeAt: Date, costUsd = 0.5): LedgerEntry => ({
  caller: "clerk-agent",
  model: "test/clerk",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
  provider: "test",
  ledgerId,
  madeAt,
});

const counter: CostCounter = {
  budget: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  key: "clauses",
  period: "2026-10-18",
};

/** A migrated schema whose pruning mark is `MARK`, and the ledger on it. */
async function markedLedger(): Promise<{ url: string; ledger: PostgresCostLedgerRepository }> {
  const url = await freshSchema();
  await migratePostgres({ url });
  const ledger = new PostgresCostLedgerRepository(connectionTo(url));
  await ledger.deleteByMadeAtBefore(MARK);
  return { url, ledger };
}

const heldIds = async (url: string): Promise<string[]> =>
  (await onSchema(url, "SELECT ledger_id FROM agboss_cost_entries ORDER BY ledger_id")).rows.map(
    (row: { ledger_id: string }) => row.ledger_id,
  );

describe("PostgresCostLedgerRepository: the save's clauses", () => {
  it("one entry made before the mark refuses the whole save: the others are not held either", async () => {
    const { url, ledger } = await markedLedger();

    await expect(
      ledger.saveAll([counter], [entry("fresh", AFTER), entry("stale", BEFORE)]),
    ).rejects.toMatchObject({ code: "cost-ledger.entry-expired" });

    expect(await heldIds(url)).toEqual([]);
    // no counter is written either, not even at zero
    const counters = await onSchema(url, "SELECT count(*)::int AS n FROM agboss_cost_counters");
    expect(counters.rows).toEqual([{ n: 0 }]);
  });

  it("an entry a prune deleted while its save waited for the mark is a replay: counted once, not refused", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });
    const ledger = new PostgresCostLedgerRepository(connectionTo(url));
    await ledger.saveAll([counter], [entry("replayed", BEFORE)]);
    // a prune that holds the mark's row, not yet committed
    const prune = await openTransaction(url);
    await prune.query("UPDATE agboss_cost_entries_pruned SET pruned_before = $1", [MARK]);

    // the save's statement reads the entry held, then the mark at the prune's value, once it commits
    const saving = ledger.saveAll([counter], [entry("replayed", BEFORE)]);
    const isBlocked = await blockedBefore(url, await pidOf(prune), saving);
    await prune.query("DELETE FROM agboss_cost_entries WHERE made_at < $1", [MARK]);
    await prune.query("COMMIT");
    await prune.end();

    expect(isBlocked).toBe(true);
    await expect(saving).resolves.toBeUndefined();
    expect((await ledger.findUsageByCounter(counter)).spent).toBe(0.5);
    expect(await heldIds(url)).toEqual([]);
  });

  it("a counter is the budget, the scope, the key and the period: each tells it from another", async () => {
    const { ledger } = await markedLedger();
    await ledger.saveAll([counter], [entry("spent", AFTER)]);

    expect((await ledger.findUsageByCounter(counter)).spent).toBe(0.5);
    expect((await ledger.findUsageByCounter({ ...counter, budget: "another-budget" })).spent).toBe(
      0,
    );
    expect(
      (await ledger.findUsageByCounter({ ...counter, scope: BudgetScope.Application })).spent,
    ).toBe(0);
  });

  it("a budget's account is its budget, scope and key: each tells it from another", async () => {
    const { ledger } = await markedLedger();
    const account = { budget: counter.budget, scope: counter.scope, key: counter.key };
    await ledger.saveLimit(account, { maxSpend: usd(10) });

    expect(
      (await ledger.findLimitByAccount({ ...account, budget: "another-budget" }))?.maxSpend,
    ).toBeUndefined();
    expect((await ledger.findLimitByAccount(account))?.maxSpend).toBe(10);
  });

  it("a violation of another unique key of the entries is an error, not an entry skipped", async () => {
    const { url, ledger } = await markedLedger();
    // a second unique key (a later migration's): only the ledger id's conflict is ignored
    await onSchema(
      url,
      "CREATE UNIQUE INDEX entries_made_at_unique ON agboss_cost_entries (made_at)",
    );

    await expect(
      ledger.saveAll([counter], [entry("first", AFTER), entry("second", AFTER)]),
    ).rejects.toMatchObject({ code: "23505" });

    expect(await heldIds(url)).toEqual([]);
    expect((await ledger.findUsageByCounter(counter)).spent).toBe(0);
  });
});
