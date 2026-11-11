import {
  BudgetScope,
  CostLedgerEntryExpiredError,
  CostLedgerRepository,
  Injectable,
  type BudgetAccount,
  type CostCounter,
  type LedgerEntry,
} from "@agboss/core";
import { assertLedgerCutoff, assertLedgerEntries } from "@agboss/core/stores";
import { usd, type Usd } from "@agboss/core/units";
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";
import { PostgresLedgerMarkMissingError } from "../errors.js";

/**
 * Adds to every counter of the arrays (one counter per index), in one statement: the cost of each
 * entry of `$5` / `$6` / `$7` (ids, costs, `madeAt`s; every save is of entries, agbossjs/agboss#817)
 * whose id this statement inserts (agbossjs/agboss#727: an id already there, or inserted
 * by a save that commits first, adds nothing; the unique key makes the later save wait for the
 * earlier one). The pruning mark (agbossjs/agboss#771) is read `FOR SHARE`: a prune's `UPDATE` of it
 * waits for this statement, or this one waits for the prune and reads the new mark (a locked row is
 * read at its latest version). An entry made before the mark is never inserted; one the table does
 * not hold is `expired`, and then nothing of the save is added — the statement answers the expired
 * ids; without the mark's row (its migration seeds it) nothing is added and the save fails. A
 * counter given twice counts twice (grouped first — one upsert may not touch a row twice),
 * and the rows are upserted in key order, so two saves of overlapping counters lock them in one
 * order and never deadlock.
 */
const ADD = `WITH mark AS (
    SELECT pruned_before FROM agboss_cost_entries_pruned WHERE id FOR SHARE
  ), given AS (
    SELECT * FROM unnest($5::text[], $6::double precision[], $7::timestamptz[])
      AS entry (ledger_id, cost, made_at)
  ), expired AS (
    SELECT given.ledger_id FROM given, mark
      WHERE given.made_at < mark.pruned_before
        AND NOT EXISTS (SELECT 1 FROM agboss_cost_entries held WHERE held.ledger_id = given.ledger_id)
  ), inserted AS (
    INSERT INTO agboss_cost_entries (ledger_id, made_at)
      SELECT given.ledger_id, given.made_at FROM given, mark
        WHERE given.made_at >= mark.pruned_before AND NOT EXISTS (SELECT 1 FROM expired)
    ON CONFLICT (ledger_id) DO NOTHING
    RETURNING ledger_id
  ), spent AS (
    SELECT COALESCE(sum(given.cost), 0) AS usd
      FROM given WHERE given.ledger_id IN (SELECT ledger_id FROM inserted)
  ), counted AS (
    INSERT INTO agboss_cost_counters AS counter
      (budget, scope, scope_key, period, spent_usd)
    SELECT budget, scope, scope_key, period, count(*) * (SELECT usd FROM spent)
      FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
        AS counted (budget, scope, scope_key, period)
      WHERE NOT EXISTS (SELECT 1 FROM expired) AND EXISTS (SELECT 1 FROM mark)
      GROUP BY budget, scope, scope_key, period
      ORDER BY budget, scope, scope_key, period
    ON CONFLICT (budget, scope, scope_key, period)
      DO UPDATE SET spent_usd = counter.spent_usd + EXCLUDED.spent_usd
  )
  SELECT EXISTS (SELECT 1 FROM mark) AS marked,
    (SELECT array_agg(ledger_id) FROM expired) AS expired,
    CASE WHEN EXISTS (SELECT 1 FROM expired) THEN (SELECT pruned_before FROM mark) END
      AS pruned_before`;

/**
 * Prunes the entries (agbossjs/agboss#771), in one statement: the mark raised to `$1` (never
 * lowered) under its row lock — a save holding it `FOR SHARE` finishes first — then every entry
 * made before the mark deleted.
 */
const PRUNE = `WITH mark AS (
    UPDATE agboss_cost_entries_pruned SET pruned_before = greatest(pruned_before, $1::timestamptz)
      WHERE id RETURNING pruned_before
  )
  DELETE FROM agboss_cost_entries WHERE made_at < (SELECT pruned_before FROM mark)`;

/** What a save answers: the entries it refused and the mark, or none (both `null`). */
const ExpiredRow = z.object({
  marked: z.boolean(),
  expired: z.array(z.string()).nullable(),
  pruned_before: z.date().nullable(),
});

/** The entries of a save, one per `ledgerId` (the first), as the statement's arrays. */
function entriesOf(given: readonly LedgerEntry[]): {
  readonly ids: string[];
  readonly costs: number[];
  readonly madeAt: Date[];
} {
  const entries = new Map<string, LedgerEntry>();
  for (const entry of given) if (!entries.has(entry.ledgerId)) entries.set(entry.ledgerId, entry);
  const kept = [...entries.values()];
  return {
    ids: [...entries.keys()],
    costs: kept.map((entry) => entry.costUsd),
    // to the millisecond, as made (a timestamptz keeps microseconds)
    madeAt: kept.map((entry) => entry.madeAt),
  };
}

const SpentRow = z.object({ spent_usd: z.number() });
const MaxSpendRow = z.object({ max_spend_usd: z.number() });

/** The scope as stored: one of `BudgetScope`'s values (anything else is refused). */
const scopeOf = (account: BudgetAccount): string => z.enum(BudgetScope).parse(account.scope);

/**
 * `CostLedgerRepository` on PostgreSQL (agbossjs/agboss#483): one row per counter — budget, scope,
 * scope key and period — so the instances of an application share a tenant's day. `saveAll` takes
 * ledger entries only (agbossjs/agboss#817: anything else refused by `assertLedgerEntries` first)
 * and is one statement: the entries' ids inserted into `agboss_cost_entries` with their dates (a repeated
 * one adds nothing, agbossjs/agboss#727; one made before the pruning mark and not held refuses the
 * save, agbossjs/agboss#771), then `INSERT … ON CONFLICT DO UPDATE SET spent_usd = spent_usd + …` of every
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

  async saveAll(counters: readonly CostCounter[], entries: readonly LedgerEntry[]): Promise<void> {
    // a JS caller's record without an identity is refused before anything (agbossjs/agboss#817)
    assertLedgerEntries(entries);
    if (counters.length === 0 || entries.length === 0) return;
    const { ids, costs, madeAt } = entriesOf(entries);
    const row = await firstRowOf(this.connection.pool, ADD, [
      counters.map((counter) => counter.budget),
      counters.map(scopeOf),
      counters.map((counter) => counter.key),
      counters.map((counter) => counter.period),
      ids,
      costs,
      madeAt,
    ]);
    const { marked, expired, pruned_before: prunedBefore } = ExpiredRow.parse(row);
    // without its mark the ledger cannot tell a pruned entry: nothing was added (agbossjs/agboss#771)
    if (!marked) throw new PostgresLedgerMarkMissingError();
    if (expired !== null && prunedBefore !== null)
      throw new CostLedgerEntryExpiredError({ ledgerIds: expired, prunedBefore });
  }

  async deleteByMadeAtBefore(cutoff: Date): Promise<void> {
    // a cutoff that is no date would lower the mark: refused with the ledger's code,
    // cost-ledger.cutoff-invalid (agbossjs/agboss#817, agbossjs/agboss#869)
    assertLedgerCutoff(cutoff);
    await changesOf(this.connection.pool, PRUNE, [cutoff]);
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
