import type { ExecutionRecordStatus, TurnOutcome } from "@agboss/core";
import type { StatusContext } from "@agboss/core/stores";
import type pg from "pg";
import { z } from "zod";
import { changesOf, firstRowOf } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { appendRecordStatus } from "../status-log.js";
import { outcomeParameters } from "./record-rows.js";
import { TOUCH } from "./record-writes.js";

/** A record's completion: its outcome, its thread's activity and its status row, in one transaction. */

const COMPLETE = `UPDATE agboss_execution_records SET reply_with = $1, status = $2,
  stop_reason = $3, route = $4::jsonb, steps = $5::jsonb, cost_usd = $6 WHERE id = $7`;

const ThreadOf = z.object({ tenant_id: z.string(), thread_id: z.string() });

/**
 * Writes the outcome, the thread's activity and its status row in one transaction; with `expected`,
 * only while the record's status is it — one compare-and-set statement, atomic.
 */
export function completeRecord(
  pool: pg.Pool,
  id: string,
  outcome: TurnOutcome,
  write: CompleteWrite,
): Promise<boolean> {
  return inPoolTransaction(pool, (client) => completedIn(client, id, outcome, write));
}

/** What a completion writes besides the outcome. */
export interface CompleteWrite {
  readonly now: Date;
  readonly expected?: ExecutionRecordStatus | undefined;
  readonly context?: StatusContext | undefined;
}

/** `completeRecord`'s statements, in the caller's transaction. */
export async function completedIn(
  client: pg.PoolClient,
  id: string,
  outcome: TurnOutcome,
  write: CompleteWrite,
): Promise<boolean> {
  const parameters = [...outcomeParameters(outcome), id];
  const guarded = write.expected === undefined ? "" : " AND status = $8";
  const row = await firstRowOf(
    client,
    `${COMPLETE}${guarded} RETURNING tenant_id, thread_id`,
    write.expected === undefined ? parameters : [...parameters, write.expected],
  );
  if (row === undefined) return false;
  const { tenant_id: tenantId, thread_id: threadId } = ThreadOf.parse(row);
  await changesOf(client, TOUCH, [write.now, tenantId, threadId]);
  await appendRecordStatus(
    client,
    { tenantId, threadId },
    {
      status: outcome.status,
      context: write.context,
      at: write.now,
    },
  );
  return true;
}
