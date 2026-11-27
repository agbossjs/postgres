import {
  CLUSTER_LEASE_EXPIRY,
  ClusterLeaseSyncOutcome,
  ExecutionLeaseRepository,
  MirroredLeaseState,
  type ClusterLeaseMirror,
  type ClusterLeaseTake,
  type ClusterLeaseSync,
  type ExecutionLease,
  type ExecutionTree,
  type MirroredLease,
} from "@agboss/core/stores";
import type {
  InterruptMode,
  NewStatusTransition,
  PauseMarks,
  PauseRequest,
  StopMark,
  StoreClock,
  TreeMarks,
} from "@agboss/core";
import { z } from "zod";
import type { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";
import { inPoolTransaction } from "../connection/transaction.js";
import { markCancel } from "./cancel-fence.js";
import { liftPause, markPause, markStop, marksOf, pauseMarksOf, stopOf } from "./lease-marks.js";
import { storeNowOf } from "./store-time.js";

/**
 * The part of the lease store that keeps the tree's marks and mirrors a cluster's lease (agbossjs/agboss#1321e,
 * #1341): the base of `PostgresExecutionLeaseRepository`. Each mark is one transaction with its
 * history row; the row is the authority (D6).
 */

/** The live-for-good expiry of a mirrored cluster lease, as the database reads it (`CLUSTER_LEASE_EXPIRY`). */
const MIRRORED_EXPIRY = `${String(CLUSTER_LEASE_EXPIRY.getUTCFullYear())}-09-13 00:00:00+00`;

/**
 * Writes the cluster's lease into the tree's row in one atomic upsert: only above the row's token,
 * or at it for the same holder not yet released; never over a retired (`finished`) row. The marks
 * are not touched, and the fence only when the sync is a reclaim (`$6`, agbossjs/agboss#1341c)
 * under an `Immediate` pause: it rises to the mirrored token, as the reclaim's own statement does.
 */
const SYNC = `INSERT INTO agboss_execution_leases AS lease (tenant_id, root_execution_id,
    holder_instance_id, token, expires_at, released, yielded, superseded)
  VALUES ($1, $2, $3, $4, $5::timestamptz, false, false, false)
  ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
    holder_instance_id = EXCLUDED.holder_instance_id, token = EXCLUDED.token,
    expires_at = EXCLUDED.expires_at, released = false, yielded = false, superseded = false,
    fenced_through_token = CASE WHEN $6::boolean AND lease.is_externally_paused
      AND lease.external_pause_mode = 'immediate'
      THEN GREATEST(COALESCE(lease.fenced_through_token, 0), EXCLUDED.token)
      ELSE lease.fenced_through_token END
  WHERE NOT lease.finished AND (lease.token < EXCLUDED.token OR
    (lease.token = EXCLUDED.token AND lease.holder_instance_id = EXCLUDED.holder_instance_id
      AND NOT lease.released))`;

const MirrorRow = z.object({
  holder_instance_id: z.string(),
  token: z.number(),
  released: z.boolean(),
  finished: z.boolean(),
});

export abstract class PostgresLeaseMarks
  extends ExecutionLeaseRepository
  implements ClusterLeaseMirror
{
  constructor(
    protected readonly connection: PostgresConnection,
    protected readonly clock: StoreClock,
  ) {
    super();
  }

  async syncClusterLease(
    lease: ExecutionLease,
    take?: ClusterLeaseTake,
  ): Promise<ClusterLeaseSync> {
    const { pool } = this.connection;
    const written = await changesOf(pool, SYNC, [
      ...[lease.tenantId, lease.rootExecutionId, lease.holderInstanceId, lease.token],
      MIRRORED_EXPIRY,
      take?.isReclaim === true,
    ]);
    if (written === 1) return { outcome: ClusterLeaseSyncOutcome.Synced };
    const stored = await this.#mirrorRow(lease);
    if (stored?.finished === true) return { outcome: ClusterLeaseSyncOutcome.Retired };
    return { outcome: ClusterLeaseSyncOutcome.Behind, rowToken: stored?.token ?? lease.token };
  }

  async endClusterLease(
    lease: ExecutionLease,
    end: { readonly isRetired: boolean },
  ): Promise<void> {
    await (end.isRetired ? this.retire(lease) : this.release(lease));
  }

  async mirroredLeaseOf(tree: ExecutionTree): Promise<MirroredLease | undefined> {
    const row = await this.#mirrorRow(tree);
    if (row === undefined) return undefined;
    let state = MirroredLeaseState.Held;
    if (row.finished) state = MirroredLeaseState.Retired;
    else if (row.released) state = MirroredLeaseState.Released;
    return { token: row.token, holderInstanceId: row.holder_instance_id, state };
  }

  async #mirrorRow(tree: Pick<ExecutionTree, "tenantId" | "rootExecutionId">) {
    const row = await firstRowOf(
      this.connection.pool,
      `SELECT holder_instance_id, token, released, finished FROM agboss_execution_leases
       WHERE tenant_id = $1 AND root_execution_id = $2`,
      [tree.tenantId, tree.rootExecutionId],
    );
    return row === undefined ? undefined : MirrorRow.parse(row);
  }

  requestCancel(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void> {
    const now = storeNowOf(this.clock);
    return inPoolTransaction(this.connection.pool, (client) =>
      markCancel(client, tree, { now, at: this.clock.now(), transition }),
    );
  }

  isCancelRequested(tree: ExecutionTree): Promise<boolean> {
    return marksOf(this.connection.pool, tree).then((marks) => marks.isCancelRequested);
  }

  requestStop(
    tree: ExecutionTree,
    mode: InterruptMode,
    transition?: NewStatusTransition,
  ): Promise<void> {
    const write = { mode, now: storeNowOf(this.clock), at: this.clock.now(), transition };
    return inPoolTransaction(this.connection.pool, (client) => markStop(client, tree, write));
  }

  stopOf(tree: ExecutionTree): Promise<StopMark | undefined> {
    return stopOf(this.connection.pool, tree);
  }

  override markedOf(tree: ExecutionTree): Promise<TreeMarks> {
    return marksOf(this.connection.pool, tree);
  }

  requestPause(
    tree: ExecutionTree,
    request: PauseRequest,
    transition?: NewStatusTransition,
  ): Promise<void> {
    const write = { request, now: storeNowOf(this.clock), at: this.clock.now(), transition };
    return inPoolTransaction(this.connection.pool, (client) => markPause(client, tree, write));
  }

  unpause(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void> {
    const write = { now: storeNowOf(this.clock), at: this.clock.now(), transition };
    return inPoolTransaction(this.connection.pool, (client) => liftPause(client, tree, write));
  }

  pauseOf(tree: ExecutionTree): Promise<PauseMarks> {
    return pauseMarksOf(this.connection.pool, tree);
  }
}
