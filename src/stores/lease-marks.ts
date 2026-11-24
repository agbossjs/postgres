import {
  InterruptMode,
  type NewStatusTransition,
  type PauseMarks,
  type PauseRequest,
  type StopMark,
  type TreeMarks,
} from "@agboss/core";
import type { ExecutionTree } from "@agboss/core/stores";
import type { PoolClient } from "pg";
import { z } from "zod";
import { changesOf, firstRowOf } from "../connection/query.js";
import { escapedText, unescapedText } from "./nul-escape.js";
import { appendStatus } from "./status-log.js";
import { storeNow } from "./store-time.js";

/**
 * The stop and pause marks of a tree on PostgreSQL (agbossjs/agboss#1341b, #1341c): columns of the
 * tree's own lease row (`stop_requested_at`, `stop_mode`, `is_externally_paused`,
 * `external_pause_reason`, `external_pause_mode`, `fenced_through_token`), written with the
 * thread's history row in ONE transaction (the DB row is the authority). A tree with no row gets a
 * seed row (token 0, released, never held). `fenced_through_token` only rises (`GREATEST`) and is
 * never cleared.
 */

type Tree = Pick<ExecutionTree, "tenantId" | "rootExecutionId">;

/** The time a mark is written at: the database's, or the test's clock (`$3`). */
const NOW = storeNow(3);

/** The row the marks of a tree read, locked for the write that follows. */
const ROW_LOCK = "FOR UPDATE";

const MarksRow = z.object({
  is_cancelled: z.boolean(),
  stop_mode: z.enum(InterruptMode).nullable(),
  is_externally_paused: z.boolean(),
  external_pause_reason: z.string().nullable(),
  external_pause_mode: z.string().nullable(),
  fenced_through_token: z.number().nullable(),
});

const MARK_COLUMNS = `cancel_requested_at IS NOT NULL AS is_cancelled, stop_mode, is_externally_paused,
  external_pause_reason, external_pause_mode, fenced_through_token`;

const readMarks = async (database: Pick<PoolClient, "query">, tree: Tree, lock: string) => {
  const row = await firstRowOf(
    database as PoolClient,
    `SELECT ${MARK_COLUMNS} FROM agboss_execution_leases
     WHERE tenant_id = $1 AND root_execution_id = $2 ${lock}`,
    [tree.tenantId, tree.rootExecutionId],
  );
  return row === undefined ? undefined : MarksRow.parse(row);
};

const pauseOf = (row: z.infer<typeof MarksRow>): PauseMarks => ({
  ...(row.is_externally_paused
    ? {
        pause: {
          ...(row.external_pause_reason === null
            ? {}
            : { reason: unescapedText(row.external_pause_reason) }),
          mode:
            row.external_pause_mode === InterruptMode.Immediate
              ? InterruptMode.Immediate
              : InterruptMode.AfterStep,
        },
      }
    : {}),
  ...(row.fenced_through_token === null ? {} : { fencedThroughToken: row.fenced_through_token }),
});

/** Both marks and the pause of the tree's lease row, in one read. */
export async function marksOf(database: Pick<PoolClient, "query">, tree: Tree): Promise<TreeMarks> {
  const row = await readMarks(database, tree, "");
  if (row === undefined) return { isCancelRequested: false };
  return {
    isCancelRequested: row.is_cancelled,
    ...(row.stop_mode === null ? {} : { stop: { mode: row.stop_mode } }),
    ...pauseOf(row),
  };
}

/** The tree's stop mark; `undefined` for a tree never stopped. */
export async function stopOf(
  database: Pick<PoolClient, "query">,
  tree: Tree,
): Promise<StopMark | undefined> {
  return (await marksOf(database, tree)).stop;
}

/** The tree's external pause and its fence. */
export async function pauseMarksOf(
  database: Pick<PoolClient, "query">,
  tree: Tree,
): Promise<PauseMarks> {
  const marks = await marksOf(database, tree);
  return {
    ...(marks.pause === undefined ? {} : { pause: marks.pause }),
    ...(marks.fencedThroughToken === undefined
      ? {}
      : { fencedThroughToken: marks.fencedThroughToken }),
  };
}

interface Write {
  readonly now: Date | null;
  readonly at: Date;
  readonly transition?: NewStatusTransition | undefined;
}

/** The status row of a mark, in the mark's transaction. */
const logged = async (client: PoolClient, write: Write): Promise<void> => {
  if (write.transition !== undefined) await appendStatus(client, write.transition, write.at);
};

const SEED = `INSERT INTO agboss_execution_leases AS lease (tenant_id, root_execution_id,
  holder_instance_id, token, expires_at, released`;

const STOP = `${SEED}, stop_requested_at, stop_mode)
  VALUES ($1, $2, '', 0, ${NOW}, true, ${NOW}, $4)
  ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
    stop_requested_at = COALESCE(lease.stop_requested_at, EXCLUDED.stop_requested_at),
    stop_mode = EXCLUDED.stop_mode`;

/**
 * Marks the stop in the caller's transaction: once, escalated from `after-step` to `immediate`,
 * never lowered; the history row only when this call set or escalated the mark.
 */
export async function markStop(
  client: PoolClient,
  tree: Tree,
  stop: Write & { readonly mode: InterruptMode },
): Promise<void> {
  const before = (await readMarks(client, tree, ROW_LOCK))?.stop_mode ?? undefined;
  const isEscalated = before === InterruptMode.AfterStep && stop.mode === InterruptMode.Immediate;
  if (before !== undefined && !isEscalated) return;
  await changesOf(client, STOP, [tree.tenantId, tree.rootExecutionId, stop.now, stop.mode]);
  await logged(client, stop);
}

const PAUSE = `${SEED}, is_externally_paused, external_pause_reason,
  fenced_through_token, external_pause_mode)
  VALUES ($1, $2, '', 0, ${NOW}, true, true, $4, $5, $6)
  ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
    is_externally_paused = true, external_pause_reason = EXCLUDED.external_pause_reason,
    external_pause_mode = CASE WHEN lease.is_externally_paused
      AND lease.external_pause_mode = 'immediate' THEN 'immediate'
      ELSE EXCLUDED.external_pause_mode END,
    fenced_through_token = CASE WHEN $7::boolean THEN
      GREATEST(COALESCE(lease.fenced_through_token, 0), lease.token)
      ELSE lease.fenced_through_token END`;

/** Marks the tree paused from outside, in the caller's transaction (`requestPause`). */
export async function markPause(
  client: PoolClient,
  tree: Tree,
  pause: Write & { readonly request: PauseRequest },
): Promise<void> {
  const wasPaused = (await readMarks(client, tree, ROW_LOCK))?.is_externally_paused === true;
  const isImmediate = pause.request.mode === InterruptMode.Immediate;
  const { reason, mode } = pause.request;
  await changesOf(client, PAUSE, [
    ...[tree.tenantId, tree.rootExecutionId, pause.now],
    reason === undefined ? null : escapedText(reason),
    isImmediate ? 0 : null,
    mode,
    isImmediate,
  ]);
  if (!wasPaused) await logged(client, pause);
}

/** Lifts the pause in the caller's transaction; the fence stays. */
export async function liftPause(client: PoolClient, tree: Tree, lift: Write): Promise<void> {
  if ((await readMarks(client, tree, ROW_LOCK))?.is_externally_paused !== true) return;
  await changesOf(
    client,
    `UPDATE agboss_execution_leases SET is_externally_paused = false,
       external_pause_reason = NULL, external_pause_mode = NULL
     WHERE tenant_id = $1 AND root_execution_id = $2`,
    [tree.tenantId, tree.rootExecutionId],
  );
  await logged(client, lift);
}
