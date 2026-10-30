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
 * Adds `$5` to every counter of the arrays (one counter per index) in one statement: a counter
 * given twice counts twice (grouped first — one upsert may not touch a row twice), and the rows
 * are upserted in key order, so two saves of overlapping counters lock them in one order and never
 * deadlock.
 */
const ADD = `INSERT INTO agboss_cost_counters AS counter
    (budget, scope, scope_key, period, spent_usd)
  SELECT budget, scope, scope_key, period, count(*) * $5::double precision
    FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
      AS given (budget, scope, scope_key, period)
    GROUP BY budget, scope, scope_key, period
    ORDER BY budget, scope, scope_key, period
  ON CONFLICT (budget, scope, scope_key, period)
    DO UPDATE SET spent_usd = counter.spent_usd + EXCLUDED.spent_usd`;

const SpentRow = z.object({ spent_usd: z.number() });
const MaxSpendRow = z.object({ max_spend_usd: z.number() });

/** The scope as stored: one of `BudgetScope`'s values (anything else is refused). */
const scopeOf = (account: BudgetAccount): string => z.enum(BudgetScope).parse(account.scope);

/** What the calls cost together, in USD. */
const costOf = (records: readonly UsageRecord[]): number =>
  records.reduce((sum, record) => sum + record.costUsd, 0);

/**
 * `CostLedgerRepository` on PostgreSQL (agbossjs/agboss#483): one row per counter — budget, scope,
 * scope key and period — so the instances of an application share a tenant's day. `saveAll` is
 * one `INSERT … ON CONFLICT DO UPDATE SET spent_usd = spent_usd + …` of every counter it is given:
 * an addition under the row's own lock, so two instances' concurrent saves lose nothing. No other
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
    await changesOf(this.connection.pool, ADD, [
      counters.map((counter) => counter.budget),
      counters.map(scopeOf),
      counters.map((counter) => counter.key),
      counters.map((counter) => counter.period),
      costOf(records),
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
