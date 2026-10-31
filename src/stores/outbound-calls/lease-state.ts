import { OutboundCallLeaseState, type OutboundCallLease } from "@agboss/core";
import type { PoolClient } from "pg";
import { z } from "zod";
import { changesOf, firstRowOf } from "../../connection/query.js";

/**
 * `PostgresOutboundCallRepository.leaseStateOf` (agbossjs/agboss#508), in the caller's transaction:
 * the lease row `SELECT … FOR UPDATE` — a renewal, a yield, a reclaim or a take of it waits, or has
 * landed and is what is read — then, for an expired one still at the token, the close: released at
 * its epoch and `superseded`, so its holder can neither renew, yield, reclaim nor write under it
 * again, and the next take names it as `takenOverFrom`. A late renewal and the close never both
 * win: whichever locks the row first decides what the other finds.
 */

const LOCK_LEASE = `SELECT lease_epoch, expires_at, released FROM agboss_execution_leases
  WHERE tenant_id = $1 AND root_execution_id = $2 FOR UPDATE`;

const CLOSE = `UPDATE agboss_execution_leases SET released = true, superseded = true
  WHERE tenant_id = $1 AND root_execution_id = $2 AND lease_epoch = $3`;

const LeaseRow = z.object({ lease_epoch: z.number(), expires_at: z.date(), released: z.boolean() });

/** The lease's state at its token as of `now`; an expired one is closed now. */
export async function leaseStateIn(
  client: PoolClient,
  lease: OutboundCallLease,
  now: Date,
): Promise<OutboundCallLeaseState> {
  const { tenantId, leaseExecutionId, token } = lease;
  const row = await firstRowOf(client, LOCK_LEASE, [tenantId, leaseExecutionId]);
  const found = row === undefined ? undefined : LeaseRow.parse(row);
  if (found === undefined || found.released || found.lease_epoch !== token)
    return OutboundCallLeaseState.Ended;
  if (found.expires_at.getTime() > now.getTime()) return OutboundCallLeaseState.Live;
  await changesOf(client, CLOSE, [tenantId, leaseExecutionId, token]);
  return OutboundCallLeaseState.Superseded;
}
