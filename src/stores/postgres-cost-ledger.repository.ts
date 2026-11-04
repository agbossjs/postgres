import {
  BudgetScope,
  CostLedgerRepository,
  Injectable,
  type BudgetAccount,
  type CostCounter,
  type UsageRecord,
} from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";

/**
 * Adds to every counter of the arrays (one counter per index), in one statement: `$5` — the cost of
 * the records without a `ledgerId` — plus the cost of each entry of `$6` / `$7` (ids, costs) whose id
 * this statement inserts (agbossjs/agboss#727: an id already there, or inserted by a save that
 * commits first, adds nothing; the unique key makes the later save wait for the earlier one). A
 * counter given twice counts twice (grouped first — one upsert may not touch a row twice), and the
 * rows are upserted in key order, so two saves of overlapping counters lock them in one order and
 * never deadlock.
 */
const ADD = `WITH inserted AS (
    INSERT INTO agboss_cost_entries (ledger_id) SELECT unnest($6::text[])
    ON CONFLICT (ledger_id) DO NOTHING
    RETURNING ledger_id
  ), spent AS (
    SELECT $5::double precision + COALESCE(sum(entry.cost), 0) AS usd
      FROM unnest($6::text[], $7::double precision[]) AS entry (ledger_id, cost)
      WHERE entry.ledger_id IN (SELECT ledger_id FROM inserted)
  )
  INSERT INTO agboss_cost_counters AS counter
    (budget, scope, scope_key, period, spent_usd)
  SELECT budget, scope, scope_key, period, count(*) * (SELECT usd FROM spent)
    FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
      AS given (budget, scope, scope_key, period)
    GROUP BY budget, scope, scope_key, period
    ORDER BY budget, scope, scope_key, period
  ON CONFLICT (budget, scope, scope_key, period)
    DO UPDATE SET spent_usd = counter.spent_usd + EXCLUDED.spent_usd`;

/** The entries of `records` (one per `ledgerId`, the first), and what the others cost. */
function entriesOf(records: readonly UsageRecord[]): {
  readonly ids: string[];
  readonly costs: number[];
  readonly unnamed: number;
} {
  const entries = new Map<string, number>();
  let unnamed = 0;
  for (const { ledgerId, costUsd } of records) {
    if (ledgerId === undefined) unnamed += costUsd;
    else if (!entries.has(ledgerId)) entries.set(ledgerId, costUsd);
  }
  return { ids: [...entries.keys()], costs: [...entries.values()], unnamed };
}

const SpentRow = z.object({ spent_usd: z.number() });
const MaxSpendRow = z.object({ max_spend_usd: z.number() });

/** The scope as stored: one of `BudgetScope`'s values (anything else is refused). */
const scopeOf = (account: BudgetAccount): string => z.enum(BudgetScope).parse(account.scope);

/**
 * `CostLedgerRepository` on PostgreSQL (agbossjs/agboss#483): one row per counter — budget, scope,
 * scope key and period — so the instances of an application share a tenant's day. `saveAll` is
 * one statement: the entries' ids inserted into `agboss_cost_entries` (a repeated one adds nothing,
 * agbossjs/agboss#727), then `INSERT … ON CONFLICT DO UPDATE SET spent_usd = spent_usd + …` of every
 * counter it is given: an addition under the row's own lock, so two instances' concurrent saves
 * lose nothing. No other
 * locking: as on SQLite, the core accepts a small overrun of executions racing past one check
 * (nothing is reserved). A read is one `SELECT` of the counter's row (`usd(0)` when none). The
 * period is the core's (the `Clock`'s UTC day, week or month), passed as text. Every statement runs
 * alone at `READ COMMITTED`. Listed in `@Application({ providers })` with `postgresUrl`.
 */
@Injectable({ deps: [PostgresConnection] })
export class PostgresCostLedgerRepository extends CostLedgerRepository {
  constructor(private readonly connection: PostgresConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async findSpentByCounter(counter: CostCounter): Promise<Usd> {
    const row = await firstRowOf(
      this.connection.pool,
      `SELECT spent_usd FROM agboss_cost_counters
       WHERE budget = $1 AND scope = $2 AND scope_key = $3 AND period = $4`,
      [counter.budget, scopeOf(counter), counter.key, counter.period],
    );
    return usd(row === undefined ? 0 : SpentRow.parse(row).spent_usd);
  }

  async saveAll(counters: readonly CostCounter[], records: readonly UsageRecord[]): Promise<void> {
    if (counters.length === 0 || records.length === 0) return;
    const { ids, costs, unnamed } = entriesOf(records);
    await changesOf(this.connection.pool, ADD, [
      counters.map((counter) => counter.budget),
      counters.map(scopeOf),
      counters.map((counter) => counter.key),
      counters.map((counter) => counter.period),
      unnamed,
      ids,
      costs,
    ]);
  }

  async findMaxSpendByAccount(account: BudgetAccount): Promise<Usd | undefined> {
    const row = await firstRowOf(
      this.connection.pool,
      `SELECT max_spend_usd FROM agboss_cost_max_spend
       WHERE budget = $1 AND scope = $2 AND scope_key = $3`,
      [account.budget, scopeOf(account), account.key],
    );
    return row === undefined ? undefined : usd(MaxSpendRow.parse(row).max_spend_usd);
  }

  async saveMaxSpend(account: BudgetAccount, maxSpend: Usd): Promise<void> {
    await changesOf(
      this.connection.pool,
      `INSERT INTO agboss_cost_max_spend (budget, scope, scope_key, max_spend_usd)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (budget, scope, scope_key) DO UPDATE SET max_spend_usd = EXCLUDED.max_spend_usd`,
      [account.budget, scopeOf(account), account.key, maxSpend],
    );
  }
}
