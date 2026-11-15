import { ExecutionCancelFencedError, cancelTreeOf, type EffectKey } from "@agboss/core/stores";
import type { PoolClient } from "pg";
import { changesOf, firstRowOf, type Queryable } from "../connection/query.js";
import { storeNow } from "./store-time.js";

/**
 * The cancel as a fence on PostgreSQL (agbossjs/agboss#909): a tree's durable cancel request is a
 * row of `agboss_execution_cancel_requests` — keyed by the tree's root, not by a lease row, which a
 * tree cancelled before its first `acquire` has none of — and the fence is a pair of advisory
 * locks of the tree's identity (namespace 909, beside the business key's 508). `requestCancel`
 * takes the exclusive one and inserts: it waits for every open fencing transaction of the tree,
 * and answers once the row is committed. A fenced write takes the shared one **after** its lease and
 * key checks, then reads the row in a new statement (`READ COMMITTED`): a transaction that started
 * while a cancel held or awaited the lock reads it committed; one that held the lock first
 * finishes before the cancel answers. No row lock, so no phantom; no deadlock — the cancel holds
 * nothing else, and every fencing transaction holds its lease row before the shared lock.
 */

const LOCK = "SELECT pg_advisory_xact_lock(hashtextextended($1, 909))";
const LOCK_SHARED = "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 909))";

const MARK = `INSERT INTO agboss_execution_cancel_requests (tenant_id, root_execution_id, requested_at)
  VALUES ($1, $2, ${storeNow(3)}) ON CONFLICT DO NOTHING`;

const FIND = `SELECT 1 AS found FROM agboss_execution_cancel_requests
  WHERE tenant_id = $1 AND root_execution_id = $2`;

/** The lock's identity of a tree: its tenant and its root, as JSON. */
const identityOf = (tree: {
  readonly tenantId: string;
  readonly rootExecutionId: string;
}): string => JSON.stringify([tree.tenantId, tree.rootExecutionId]);

/** Marks the tree's cancel in the caller's transaction: once — a repeat changes nothing. */
export async function markCancel(
  client: PoolClient,
  tree: { readonly tenantId: string; readonly rootExecutionId: string },
  now: Date | null,
): Promise<void> {
  await firstRowOf(client, LOCK, [identityOf(tree)]);
  await changesOf(client, MARK, [tree.tenantId, tree.rootExecutionId, now]);
}

/**
 * The cancel check of a fenced write, in its transaction, after the lease and the mark and — for an
 * effect — the key's lookup: the key's tree has a cancel request and the key is not an undo's →
 * `ExecutionCancelFencedError`, nothing written or sent.
 */
export async function checkCancel(client: PoolClient, key: EffectKey): Promise<void> {
  if (key.isCompensation === true) return;
  const tree = cancelTreeOf(key);
  await firstRowOf(client, LOCK_SHARED, [identityOf(tree)]);
  const found = await firstRowOf(client, FIND, [tree.tenantId, tree.rootExecutionId]);
  if (found !== undefined) throw ExecutionCancelFencedError.of(key);
}

/**
 * Removes the cancel requests older than `cutoff` whose tree is over — its lease finished (retired,
 * agbossjs/agboss#520): the fencing stores' retention. Never by age alone: a tree not over (paused
 * longer than the retention, resumed on another instance) keeps its mark, so its writes stay refused.
 */
export async function prunedCancels(database: Queryable, cutoff: Date): Promise<void> {
  await changesOf(
    database,
    `DELETE FROM agboss_execution_cancel_requests AS request
     WHERE request.requested_at < $1 AND EXISTS (
       SELECT 1 FROM agboss_execution_leases AS lease
       WHERE lease.tenant_id = request.tenant_id
         AND lease.root_execution_id = request.root_execution_id
         AND lease.finished)`,
    [cutoff],
  );
}
