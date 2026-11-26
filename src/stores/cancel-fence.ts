import { InterruptMode, type NewStatusTransition } from "@agboss/core";
import {
  cancelFencedOf,
  cancelTreeOf,
  pauseFencedOf,
  stopFencedOf,
  type EffectKey,
} from "@agboss/core/stores";
import { z } from "zod";
import type { PoolClient } from "pg";
import { changesOf, firstRowOf } from "../connection/query.js";
import { appendStatus } from "./status-log.js";
import { storeNow } from "./store-time.js";

/**
 * The cancel as a fence on PostgreSQL (agbossjs/agboss#909, #1117): a tree's durable cancel request
 * is `cancel_requested_at` on the tree's own lease row — keyed by the tree's root, never by a child's
 * lease — set once and never cleared: no retention, release, retire, take or takeover lifts it. A
 * cancel before the tree's first `acquire` writes a seed row (token 0, released, never held), so the
 * first `acquire` is token 1 and no takeover.
 *
 * The fence is that row's lock. `requestCancel` writes the mark with an upsert, which waits for every
 * share lock on the row; a fenced write reads the mark after its lease and key checks with
 * `SELECT … FOR SHARE` on the root's row, so it either holds the lock before the cancel (the cancel
 * then answers after the write's transaction ends) or reads the committed mark (`READ COMMITTED`
 * re-reads the row after waiting for the cancel's lock). A child's key reads its root's row; its
 * check first inserts the root's seed row when there is none, so there is always a row to lock. No
 * deadlock: a fencing transaction locks its own lease row, then (a child) the root's row for share;
 * nothing locks a child's row after the root's.
 */

const MARK = `INSERT INTO agboss_execution_leases AS lease
  (tenant_id, root_execution_id, holder_instance_id, token, expires_at, released,
    cancel_requested_at)
  VALUES ($1, $2, '', 0, ${storeNow(3)}, true, ${storeNow(3)})
  ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
    cancel_requested_at = COALESCE(lease.cancel_requested_at, EXCLUDED.cancel_requested_at)`;

/**
 * The only conflict the seed ignores is the root's own row: a violation of another unique key is an
 * error. A constant of its own, so the mutation shard drops it (agbossjs/agboss#1327).
 */
const ROOT_KEY = "(tenant_id, root_execution_id)";

const SEED = `INSERT INTO agboss_execution_leases
  (tenant_id, root_execution_id, holder_instance_id, token, expires_at, released)
  VALUES ($1, $2, '', 0, ${storeNow(3)}, true)
  ON CONFLICT ${ROOT_KEY} DO NOTHING`;

/**
 * Seeds the tree's row when there is none (token 0, released, never held), so the locking read that
 * follows always locks a row: `FOR UPDATE` of a row that does not exist yet locks nothing, and two
 * concurrent first writes would both read "no mark" (agbossjs/agboss#1341b, a TOCTOU).
 */
export async function seedTreeRow(
  client: PoolClient,
  tree: { readonly tenantId: string; readonly rootExecutionId: string },
  now: Date | null,
): Promise<void> {
  await changesOf(client, SEED, [tree.tenantId, tree.rootExecutionId, now]);
}

/**
 * The read's lock on the root's row: for a child's key the only lock its write holds on that row
 * (its fence locks the child's own row), so without it a cancel could answer while the write is
 * open (agbossjs/agboss#1302). A constant of its own, so the mutation shard drops it.
 */
const SHARE_LOCK = "FOR SHARE";

const FIND = `SELECT cancel_requested_at IS NOT NULL AS is_cancelled, stop_mode,
    fenced_through_token, token FROM agboss_execution_leases
  WHERE tenant_id = $1 AND root_execution_id = $2 ${SHARE_LOCK}`;

/** Marks the tree's cancel in the caller's transaction: once — a repeat changes nothing. */
export async function markCancel(
  client: PoolClient,
  tree: { readonly tenantId: string; readonly rootExecutionId: string },
  write: {
    readonly now: Date | null;
    readonly at: Date;
    readonly transition?: NewStatusTransition | undefined;
  },
): Promise<void> {
  // seeded first: the lock below always finds a row, so two concurrent cancels never both see "not marked"
  await seedTreeRow(client, tree, write.now);
  const wasMarked = await firstRowOf(
    client,
    `SELECT 1 FROM agboss_execution_leases WHERE tenant_id = $1 AND root_execution_id = $2
     AND cancel_requested_at IS NOT NULL FOR UPDATE`,
    [tree.tenantId, tree.rootExecutionId],
  );
  await changesOf(client, MARK, [tree.tenantId, tree.rootExecutionId, write.now]);
  // the mark and its history row are one transaction (#1341d), written only when this call set it
  if (write.transition !== undefined && wasMarked === undefined)
    await appendStatus(client, write.transition, write.at);
}

const FenceRow = z.object({
  is_cancelled: z.boolean(),
  stop_mode: z.string().nullable(),
  fenced_through_token: z.number().nullable(),
  token: z.number(),
});

/**
 * The tree's fences of a fenced write, in its transaction, after the lease and the mark and — for
 * an effect — the key's lookup, all on the tree's ROOT row (locked `FOR SHARE`, so a child's key is
 * checked against its root): a pause fenced the root lease through a token (#1341c) — a write of the
 * root's lease at or below it is stale, and so is a child's while the root's current token is the
 * fenced one → `ExecutionPauseFencedError` (`pauseFencedOf`); an `Immediate` stop with no cancel (#1341b) →
 * `ExecutionStopFencedError`; a cancel request and a key that is not an undo's →
 * `ExecutionError.CancelFenced`. Nothing written or sent.
 */
export async function checkCancel(
  client: PoolClient,
  key: EffectKey,
  now: Date | null,
): Promise<void> {
  const tree = cancelTreeOf(key);
  // a child's check may find no row of its root yet: one is seeded, so there is a row to lock (the
  // root's own key finds its lease row, locked by the fence: the seed changes nothing)
  await seedTreeRow(client, tree, now);
  const row = FenceRow.parse(await firstRowOf(client, FIND, [tree.tenantId, tree.rootExecutionId]));
  const fenced = row.fenced_through_token;
  if (fenced !== null) {
    const isStale =
      key.leaseExecutionId === tree.rootExecutionId ? key.token <= fenced : fenced >= row.token;
    if (isStale) throw pauseFencedOf(key);
  }
  if (!row.is_cancelled && row.stop_mode === InterruptMode.Immediate) throw stopFencedOf(key);
  if (key.isCompensation === true) return;
  if (row.is_cancelled) throw cancelFencedOf(key);
}
