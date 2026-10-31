import { ExecutionFencedError, type FencedEffectKey } from "@agboss/core";
import type { PoolClient } from "pg";
import { z } from "zod";
import { firstRowOf } from "../connection/query.js";
import { storeNow } from "./store-time.js";

/**
 * The fencing checks of the fenced stores (#500, agbossjs/agboss#505, #508) — the fenced effect and
 * the outbound call — inside the caller's transaction, in the order of #500, after the key's name
 * (each store checks it first with the core's `checkedEffectName`, agbossjs/agboss#526): its lease
 * row locked and held (its epoch, not released, not expired), then the scope's mark raised
 * to the token (a higher one refuses the key before any of its rows is read).
 */

/** The key's lease row, locked for the transaction: a renewal, a close or a takeover of it waits. */
const LOCK_LEASE = `SELECT lease_epoch, expires_at, released FROM agboss_execution_leases
  WHERE tenant_id = $1 AND root_execution_id = $2 FOR UPDATE`;

/**
 * Raises the scope's mark to the token (never lowers it); the mark as it is now, and the store's
 * time (agbossjs/agboss#533: the database's, `$3` null), read in this statement — after the lease
 * row was locked, so the wait for the lock never counts as the lease's.
 */
const RAISE_MARK = `INSERT INTO agboss_fenced_effect_marks AS mark (scope_key, highest_token, stored_at)
  VALUES ($1, $2, ${storeNow(3)})
  ON CONFLICT (scope_key) DO UPDATE SET
    highest_token = GREATEST(mark.highest_token, EXCLUDED.highest_token),
    stored_at = EXCLUDED.stored_at
  RETURNING highest_token, ${storeNow(3)} AS now`;

const LeaseRow = z.object({ lease_epoch: z.number(), expires_at: z.date(), released: z.boolean() });
const MarkRow = z.object({ highest_token: z.number(), now: z.date() });

/**
 * The key's lease is held at its token (not released, not expired at the store's time — `now`: the
 * database's when `null`, agbossjs/agboss#533) and no newer token wrote its scope — else
 * `ExecutionFencedError`; the mark is raised to the token. The lease row stays locked until the
 * caller's transaction ends.
 */
export async function checkFence(
  client: PoolClient,
  key: FencedEffectKey,
  now: Date | null,
): Promise<void> {
  const { scopeKey, token } = key;
  const row = await firstRowOf(client, LOCK_LEASE, [key.tenantId, key.leaseExecutionId]);
  const lease = row === undefined ? undefined : LeaseRow.parse(row);
  const refused = () =>
    new ExecutionFencedError({ scopeKey, token, observedToken: lease?.lease_epoch });
  if (lease === undefined || lease.released || lease.lease_epoch !== token) throw refused();
  const mark = MarkRow.parse(await firstRowOf(client, RAISE_MARK, [scopeKey, token, now]));
  // live while expires_at > now, by the store's time read after the lock (#534, #533)
  if (lease.expires_at.getTime() <= mark.now.getTime()) throw refused();
  if (mark.highest_token > token)
    throw new ExecutionFencedError({ scopeKey, token, observedToken: mark.highest_token });
}
