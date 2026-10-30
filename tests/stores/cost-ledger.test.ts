import { BudgetScope, type CostCounter, type UsageRecord } from "@agboss/core";
import { usd } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresCostLedgerRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * The cost ledger's edges beyond the contract: a counter given twice counts twice, nothing is
 * written without counters or calls, the period's rollover starts a new row, overlapping saves in
 * opposite orders never deadlock, an unknown scope is refused, and a lost connection rejects.
 */
const database = testDatabase();

const ledgerOn = (url = database.url()) => new PostgresCostLedgerRepository(connectionTo(url));

const call = (costUsd: number): UsageRecord => ({
  caller: "clerk-agent",
  model: "test/clerk",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
  costSource: "api",
});

const day = (key: string, period = "2026-10-18"): CostCounter => ({
  budget: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  key,
  period,
});

const rowsOfLedger = async (key: string): Promise<number> =>
  (await onSchema(database.url(), "SELECT 1 FROM agboss_cost_counters WHERE scope_key = $1", [key]))
    .rowCount ?? 0;

describe("PostgresCostLedgerRepository", () => {
  it("a counter given twice in one save counts twice; the calls' costs are summed", async () => {
    const ledger = ledgerOn();

    await ledger.saveAll([day("twice"), day("twice")], [call(0.5), call(0.25)]);

    expect(await ledger.findSpentByCounter(day("twice"))).toBe(1.5);
    expect(await rowsOfLedger("twice")).toBe(1);
  });

  it("no counters or no calls: nothing is written", async () => {
    const ledger = ledgerOn();

    await ledger.saveAll([], [call(1)]);
    await ledger.saveAll([day("none")], []);

    expect(await rowsOfLedger("none")).toBe(0);
    expect(await ledger.findSpentByCounter(day("none"))).toBe(0);
  });

  it("the UTC day's rollover is a new counter: the next period starts from zero", async () => {
    const ledger = ledgerOn();
    await ledger.saveAll([day("rollover", "2026-10-18")], [call(9.5)]);

    await ledger.saveAll([day("rollover", "2026-10-19")], [call(0.5)]);

    expect(await ledger.findSpentByCounter(day("rollover", "2026-10-18"))).toBe(9.5);
    expect(await ledger.findSpentByCounter(day("rollover", "2026-10-19"))).toBe(0.5);
  });

  it("two instances saving overlapping counters in opposite orders never deadlock, lose nothing", async () => {
    const [first, second] = [ledgerOn(), ledgerOn()];
    const [a, b, c] = [day("order-a"), day("order-b"), day("order-c")];

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        index % 2 === 0
          ? first.saveAll([a, b, c], [call(0.25)])
          : second.saveAll([c, b, a], [call(0.25)]),
      ),
    );

    for (const counter of [a, b, c]) expect(await first.findSpentByCounter(counter)).toBe(5);
  });

  it("the last maxSpend() of an account replaces the one before", async () => {
    const ledger = ledgerOn();
    const account = { budget: "tenant-daily-budget", scope: BudgetScope.Tenant, key: "max" };

    await ledger.saveMaxSpend(account, usd(10));
    await ledger.saveMaxSpend(account, usd(12.5));

    expect(await ledger.findMaxSpendByAccount(account)).toBe(12.5);
    expect(
      await ledger.findMaxSpendByAccount({ ...account, scope: BudgetScope.Application }),
    ).toBeUndefined();
  });

  it("a scope that is not a BudgetScope is refused before any statement", async () => {
    const ledger = ledgerOn();
    // a row written by something else than the core: its scope read from untyped JSON
    const scope = JSON.parse('{ "scope": "planet" }') as Pick<CostCounter, "scope">;
    const odd: CostCounter = { ...day("odd"), ...scope };

    await expect(ledger.saveAll([odd], [call(1)])).rejects.toThrow();
    await expect(ledger.findSpentByCounter(odd)).rejects.toThrow();
    expect(await rowsOfLedger("odd")).toBe(0);
  });

  it("a lost connection rejects ping, the reads and the writes", async () => {
    const down = ledgerOn("postgres://postgres:pw@127.0.0.1:1/postgres");
    const account = { budget: "b", scope: BudgetScope.Tenant, key: "down" };

    await expect(down.ping()).rejects.toThrow();
    await expect(down.findSpentByCounter(day("down"))).rejects.toThrow();
    await expect(down.saveAll([day("down")], [call(1)])).rejects.toThrow();
    await expect(down.findMaxSpendByAccount(account)).rejects.toThrow();
    await expect(down.saveMaxSpend(account, usd(1))).rejects.toThrow();
  });
});
