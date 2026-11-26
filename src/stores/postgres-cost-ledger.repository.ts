import { inLongTransaction } from "../connection/transaction.js";
import {
  BudgetScope,
  CostLedgerRepository,
  Injectable,
  type BudgetAccount,
  type BudgetLimit,
  type BudgetUsage,
  type CostCounter,
  type LedgerEntry,
} from "@agboss/core";
import { assertLedgerCutoff, assertLedgerEntries, StoreError } from "@agboss/core/stores";
import { usd } from "@agboss/core/units";
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";
import { PostgresLedgerMarkMissingError } from "../errors.js";

/**
 * The pruning mark's row lock (agbossjs/agboss#771): a save holds it for share, so a prune's `UPDATE`
 * of the mark waits for the save, or the save waits for the prune and reads the new mark. A
 * constant of its own, so the mutation shard drops it (agbossjs/agboss#1302). The table holds one
 * row (`id` is a primary key that must be true), so neither statement names it.
 */
const MARK_LOCK = "FOR SHARE";

/**
 * An entry the save's snapshot holds is a replay, never `expired`, even dated before the mark: a
 * prune that committed while the save waited for the mark deleted it, and the entry's cost was
 * counted before. Constants of their own, so the mutation shard drops each (agbossjs/agboss#1302).
 */
const NOT_HELD =
  "AND NOT EXISTS (SELECT 1 FROM agboss_cost_entries held WHERE held.ledger_id = given.ledger_id)";

/**
 * An entry made before the mark is never inserted, held or not: a prune that committed while the
 * save waited for the mark deleted the entry the save's snapshot still holds, and the insert's
 * conflict check no longer finds it — inserting it again would count its cost twice.
 */
const FROM_MARK = "given.made_at >= mark.pruned_before AND";

/** One expired entry refuses the whole save: no counter is written either. */
const NONE_EXPIRED = "AND NOT EXISTS (SELECT 1 FROM expired)";

/**
 * The only conflict the insert of an entry ignores is its ledger id's (a replay): a violation of
 * any other unique key is an error, not an entry skipped (its cost never counted).
 */
const ENTRY_KEY = "(ledger_id)";

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
    SELECT pruned_before FROM agboss_cost_entries_pruned ${MARK_LOCK}
  ), given AS (
    SELECT * FROM unnest($5::text[], $6::double precision[], $7::timestamptz[], $8::double precision[])
      AS entry (ledger_id, cost, made_at, tokens)
  ), expired AS (
    SELECT given.ledger_id FROM given, mark
      WHERE given.made_at < mark.pruned_before ${NOT_HELD}
  ), inserted AS (
    INSERT INTO agboss_cost_entries (ledger_id, made_at)
      SELECT given.ledger_id, given.made_at FROM given, mark
        WHERE ${FROM_MARK} NOT EXISTS (SELECT 1 FROM expired)
    ON CONFLICT ${ENTRY_KEY} DO NOTHING
    RETURNING ledger_id
  ), spent AS (
    SELECT COALESCE(sum(given.cost), 0) AS usd, COALESCE(sum(given.tokens), 0) AS tokens
      FROM given WHERE given.ledger_id IN (SELECT ledger_id FROM inserted)
  ), counted AS (
    INSERT INTO agboss_cost_counters AS counter
      (budget, scope, scope_key, period, spent_usd, tokens)
    SELECT budget, scope, scope_key, period, count(*) * (SELECT usd FROM spent),
      (count(*) * (SELECT tokens FROM spent))::bigint
      FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
        AS counted (budget, scope, scope_key, period)
      WHERE EXISTS (SELECT 1 FROM mark) ${NONE_EXPIRED}
      GROUP BY budget, scope, scope_key, period
      ORDER BY budget, scope, scope_key, period
    ON CONFLICT (budget, scope, scope_key, period)
      DO UPDATE SET spent_usd = counter.spent_usd + EXCLUDED.spent_usd,
        tokens = counter.tokens + EXCLUDED.tokens
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
      RETURNING pruned_before
  )
  DELETE FROM agboss_cost_entries WHERE made_at < (SELECT pruned_before FROM mark)`;

/** What a save answers: the entries it refused and the mark, or none (both `null`). */
const ExpiredRow = z.object({ marked: z.boolean() }).and(
  // the mark is named exactly when an entry was refused
  z.union([
    z.object({ expired: z.null(), pruned_before: z.null() }),
    z.object({ expired: z.array(z.string()), pruned_before: z.date() }),
  ]),
);

/** The entries of a save, one per `ledgerId` (the first), as the statement's arrays. */
function entriesOf(given: readonly LedgerEntry[]): {
  readonly ids: string[];
  readonly costs: number[];
  readonly tokens: number[];
  readonly madeAt: Date[];
} {
  const entries = new Map<string, LedgerEntry>();
  for (const entry of given) if (!entries.has(entry.ledgerId)) entries.set(entry.ledgerId, entry);
  const kept = [...entries.values()];
  return {
    ids: [...entries.keys()],
    costs: kept.map((entry) => entry.costUsd),
    // what a token budget counts: input and output tokens
    tokens: kept.map((entry) => entry.inputTokens + entry.outputTokens),
    // to the millisecond, as made (a timestamptz keeps microseconds)
    madeAt: kept.map((entry) => entry.madeAt),
  };
}

const UsageRow = z.object({ spent_usd: z.number(), tokens: z.coerce.number() });
const LimitRow = z.object({
  max_spend_usd: z.number().nullable(),
  max_tokens: z.coerce.number().nullable(),
});

/** What a counter that was never written holds. */
const NO_USAGE: BudgetUsage = { spent: usd(0), tokens: 0 };

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

  async findUsageByCounter(counter: CostCounter): Promise<BudgetUsage> {
    const row = await firstRowOf(
      this.connection.pool,
      `SELECT spent_usd, tokens FROM agboss_cost_counters
       WHERE budget = $1 AND scope = $2 AND scope_key = $3 AND period = $4`,
      [counter.budget, scopeOf(counter), counter.key, counter.period],
    );
    if (row === undefined) return NO_USAGE;
    const held = UsageRow.parse(row);
    return { spent: usd(held.spent_usd), tokens: held.tokens };
  }

  async saveAll(counters: readonly CostCounter[], entries: readonly LedgerEntry[]): Promise<void> {
    // a JS caller's record without an identity is refused before anything (agbossjs/agboss#817)
    assertLedgerEntries(entries);
    if (counters.length === 0 || entries.length === 0) return;
    const { ids, costs, madeAt, tokens } = entriesOf(entries);
    const row = await firstRowOf(this.connection.pool, ADD, [
      counters.map((counter) => counter.budget),
      counters.map(scopeOf),
      counters.map((counter) => counter.key),
      counters.map((counter) => counter.period),
      ids,
      costs,
      madeAt,
      tokens,
    ]);
    const answer = ExpiredRow.parse(row);
    // without its mark the ledger cannot tell a pruned entry: nothing was added (agbossjs/agboss#771)
    if (!answer.marked) throw new PostgresLedgerMarkMissingError();
    if (answer.expired !== null)
      throw new StoreError.LedgerEntryExpired({
        ledgerIds: answer.expired,
        prunedBefore: answer.pruned_before,
      });
  }

  async deleteByMadeAtBefore(cutoff: Date): Promise<void> {
    // a cutoff that is no date would lower the mark: refused with the ledger's code,
    // store.ledger-cutoff-invalid (agbossjs/agboss#817, agbossjs/agboss#869)
    assertLedgerCutoff(cutoff);
    await inLongTransaction(this.connection.pool, (client) => changesOf(client, PRUNE, [cutoff]));
  }

  async findLimitByAccount(account: BudgetAccount): Promise<BudgetLimit | undefined> {
    const row = await firstRowOf(
      this.connection.pool,
      `SELECT max_spend_usd, max_tokens FROM agboss_cost_max_spend
       WHERE budget = $1 AND scope = $2 AND scope_key = $3`,
      [account.budget, scopeOf(account), account.key],
    );
    if (row === undefined) return undefined;
    const held = LimitRow.parse(row);
    return {
      ...(held.max_spend_usd === null ? {} : { maxSpend: usd(held.max_spend_usd) }),
      ...(held.max_tokens === null ? {} : { maxTokens: held.max_tokens }),
    };
  }

  async saveLimit(account: BudgetAccount, limit: BudgetLimit): Promise<void> {
    await changesOf(
      this.connection.pool,
      `INSERT INTO agboss_cost_max_spend (budget, scope, scope_key, max_spend_usd, max_tokens)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (budget, scope, scope_key) DO UPDATE SET
         max_spend_usd = EXCLUDED.max_spend_usd, max_tokens = EXCLUDED.max_tokens`,
      [
        account.budget,
        scopeOf(account),
        account.key,
        limit.maxSpend ?? null,
        limit.maxTokens ?? null,
      ],
    );
  }
}
