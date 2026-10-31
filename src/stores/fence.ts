import {
  ExecutionFencedError,
  InvalidFencedEffectNameError,
  type FencedEffectKey,
} from "@agboss/core";
import type { PoolClient } from "pg";
import { z } from "zod";
import { firstRowOf } from "../connection/query.js";

/**
 * The fencing checks of the fenced stores (#500, agbossjs/agboss#505, #508) — the fenced effect and
 * the outbound call — inside the caller's transaction, in the order of #500: the key's name, its
 * lease row locked and held (its epoch, not released, not expired), then the scope's mark raised
 * to the token (a higher one refuses the key before any of its rows is read).
 */

/** An effect's or a call's name (#508): 1–100 of `[A-Za-z0-9._-]`, a letter or a digit first. */
const EFFECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/**
 * Refuses a key built by hand with a name that is not one (#508) — `InvalidFencedEffectNameError`,
 * before any statement, as the core's stores check it at their entry.
 */
export function checkedName(key: FencedEffectKey): void {
  if (!EFFECT_NAME.test(key.name)) throw new InvalidFencedEffectNameError(key.name.length);
}

/** The key's lease row, locked for the transaction: a renewal, a close or a takeover of it waits. */
const LOCK_LEASE = `SELECT lease_epoch, expires_at, released FROM agboss_execution_leases
  WHERE tenant_id = $1 AND root_execution_id = $2 FOR UPDATE`;

/** Raises the scope's mark to the token (never lowers it); the mark as it is now. */
const RAISE_MARK = `INSERT INTO agboss_fenced_effect_marks AS mark (scope_key, highest_token, stored_at)
  VALUES ($1, $2, $3)
  ON CONFLICT (scope_key) DO UPDATE SET
    highest_token = GREATEST(mark.highest_token, EXCLUDED.highest_token),
    stored_at = EXCLUDED.stored_at
  RETURNING highest_token`;

const LeaseRow = z.object({ lease_epoch: z.number(), expires_at: z.date(), released: z.boolean() });
const MarkRow = z.object({ highest_token: z.number() });

/**
 * The key's lease is held at its token (not released, not expired at `now`) and no newer token
 * wrote its scope — else `ExecutionFencedError`; the mark is raised to the token. The lease row
 * stays locked until the caller's transaction ends.
 */
export async function checkFence(
  client: PoolClient,
  key: FencedEffectKey,
  now: Date,
): Promise<void> {
  const { scopeKey, token } = key;
  const row = await firstRowOf(client, LOCK_LEASE, [key.tenantId, key.leaseExecutionId]);
  const lease = row === undefined ? undefined : LeaseRow.parse(row);
  const isHeld =
    lease !== undefined &&
    !lease.released &&
    lease.lease_epoch === token &&
    lease.expires_at.getTime() > now.getTime();
  if (!isHeld)
    throw new ExecutionFencedError({ scopeKey, token, observedToken: lease?.lease_epoch });
  const mark = MarkRow.parse(await firstRowOf(client, RAISE_MARK, [scopeKey, token, now]));
  if (mark.highest_token > token)
    throw new ExecutionFencedError({ scopeKey, token, observedToken: mark.highest_token });
}
