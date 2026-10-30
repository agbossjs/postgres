import type pg from "pg";
import { z } from "zod";
import { changesOf, firstRowOf } from "../../connection/query.js";

/**
 * The statements of `PostgresRateLimitRepository` (agbossjs/agboss#483). Every time is the
 * framework `Clock`'s, passed as a parameter — never the database's `now()`.
 */

/** The key's row, locked for the transaction: another instance's count of the key waits. */
const LOCK_KEY = "SELECT limit_key FROM agboss_rate_limit_keys WHERE limit_key = $1 FOR UPDATE";

/**
 * Locks the key's row (`FOR UPDATE`) for the rest of the transaction, making it first when the key
 * is new — an insert another instance makes at the same time is waited for, then locked in turn.
 */
export async function lockKey(client: pg.ClientBase, key: string): Promise<void> {
  if ((await changesOf(client, LOCK_KEY, [key])) === 1) return;
  await changesOf(
    client,
    "INSERT INTO agboss_rate_limit_keys (limit_key) VALUES ($1) ON CONFLICT DO NOTHING",
    [key],
  );
  await changesOf(client, LOCK_KEY, [key]);
}

/**
 * Takes a slot under a count check, in one statement (under the key's lock): the key's expired
 * slots are swept, and the new one inserted only while fewer than `$5` slots are valid (`expires_at
 * > now`, `$6`). Returns a row only when it took the slot.
 */
export const TAKE_SLOT = `WITH swept AS (
    DELETE FROM agboss_rate_limit_slots WHERE slot_key = $2::text AND expires_at <= $6::timestamptz
  )
  INSERT INTO agboss_rate_limit_slots (slot_id, slot_key, holder_instance_id, expires_at)
  SELECT $1::text, $2::text, $3::text, $4::timestamptz
  WHERE (SELECT count(*) FROM agboss_rate_limit_slots
    WHERE slot_key = $2 AND expires_at > $6::timestamptz) < $5::integer
  RETURNING slot_id`;

/** Extends a slot still valid; an expired one (its place may be given away) is not revived. */
export const RENEW_SLOT = `UPDATE agboss_rate_limit_slots SET expires_at = $1
  WHERE slot_id = $2 AND expires_at > $3`;

/** Keeps the later of the stored pause and the new one. */
export const PAUSE = `INSERT INTO agboss_rate_limit_pauses AS pause (pause_key, paused_until)
  VALUES ($1, $2)
  ON CONFLICT (pause_key) DO UPDATE SET
    paused_until = GREATEST(pause.paused_until, EXCLUDED.paused_until)`;

const Total = z.object({ total: z.number().nullable() });

/** What the key's buckets inside the window (`counted_at > since`) hold together. */
export async function windowTotal(
  database: pg.Pool | pg.ClientBase,
  key: string,
  since: Date,
): Promise<number> {
  const row = await firstRowOf(
    database,
    `SELECT sum(amount) AS total FROM agboss_rate_limit_window_buckets
     WHERE window_key = $1 AND counted_at > $2`,
    [key, since],
  );
  return Total.parse(row).total ?? 0;
}

/** Forgets the key's buckets at or before `since`: they left the window. */
export const forgetBefore = (client: pg.ClientBase, key: string, since: Date): Promise<number> =>
  changesOf(
    client,
    "DELETE FROM agboss_rate_limit_window_buckets WHERE window_key = $1 AND counted_at <= $2",
    [key, since],
  );

/** Adds `amount` to the key's bucket of this Clock millisecond. */
export const countInBucket = (
  client: pg.ClientBase,
  key: string,
  now: Date,
  amount: number,
): Promise<number> =>
  changesOf(
    client,
    `INSERT INTO agboss_rate_limit_window_buckets AS bucket (window_key, counted_at, amount)
     VALUES ($1, $2, $3)
     ON CONFLICT (window_key, counted_at) DO UPDATE SET amount = bucket.amount + EXCLUDED.amount`,
    [key, now, amount],
  );
