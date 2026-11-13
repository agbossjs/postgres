import type { PauseRecord } from "@agboss/core";
import type { PauseFilter, PausePage } from "@agboss/core/stores";
import type pg from "pg";
import { z } from "zod";
import { rowsOf } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { recordOfRow } from "./pause-rows.js";

/**
 * The scans of `PostgresPausedExecutionRepository` (agbossjs/agboss#935, #910 rules 9, 10, 14): the
 * deadline and reminder looks on their partial indexes, the pages by `seq` — the `bigserial` insertion
 * sequence, never a reusable id, so the cursor (its text) skips nothing when a removal comes between
 * two pages, and a deleted maximum is not given again — and the retention's look and delete.
 */

/** The largest page a scan returns. */
export const MAX_SCAN_LIMIT = 1000;

/** Throws unless `limit` is a whole number from 1 to 1000. */
export function assertScanLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCAN_LIMIT)
    throw new RangeError(
      `a pause scan's limit is a whole number from 1 to ${String(MAX_SCAN_LIMIT)}, not ${String(limit)}`,
    );
}

/** Throws unless the filter names at least one status. */
export function assertPauseFilter(filter: PauseFilter): void {
  if (filter.statuses.length === 0) throw new TypeError("a pause filter names at least one status");
}

/** The insertion sequence a cursor continues after (text of digits); no cursor: from the start. */
export function seqOfCursor(cursor: string | undefined): string {
  if (cursor === undefined) return "0";
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
    throw new TypeError(`${JSON.stringify(cursor)} is not a pause page cursor`);
  return cursor;
}

const SequencedRow = z.object({ seq: z.string(), record: z.unknown() });

/** What the retention removes: closed, resolved before `$1`, with no live mailbox (I11). */
const REMOVABLE = `p.status IN ('taken', 'cancelled') AND p.resolved_at IS NOT NULL
  AND p.resolved_at < $1 AND NOT EXISTS (SELECT 1 FROM agboss_pause_notices n
    WHERE n.tenant_id = p.tenant_id AND n.pause_id = p.pause_id AND NOT n.is_dead
      AND n.delivered < jsonb_array_length(n.notices))`;

const KeysOf = z.array(z.object({ tenant_id: z.string(), pause_id: z.string() }));

/** The page of the first `limit` of `rows` (read with one more); `next` only when more follow. */
function pageOf(rows: readonly unknown[], limit: number): PausePage {
  const sequenced = rows.map((row) => SequencedRow.parse(row));
  const page = sequenced.slice(0, limit);
  const last = page.at(-1);
  return {
    pauses: page.map(recordOfRow),
    ...(sequenced.length > limit && last !== undefined ? { next: last.seq } : {}),
  };
}

export class PauseScans {
  constructor(private readonly pool: pg.Pool) {}

  /** `Pending` pauses with `column ≤ at`, by `(column, tenant, id)`, on the column's partial index. */
  async pendingDue(
    column: "expires_at" | "remind_at",
    at: Date,
    limit: number,
  ): Promise<readonly PauseRecord[]> {
    const rows = await rowsOf(
      this.pool,
      `SELECT record FROM agboss_pauses WHERE status = 'pending' AND ${column} IS NOT NULL
         AND ${column} <= $1 ORDER BY ${column}, tenant_id COLLATE "C", pause_id COLLATE "C" LIMIT $2`,
      [at, limit],
    );
    return rows.map(recordOfRow);
  }

  /** The open pauses (`Pending`, `Resolved`) after the cursor, on `agboss_pauses_open`. */
  async open(after: string, limit: number): Promise<PausePage> {
    const rows = await rowsOf(
      this.pool,
      `SELECT record, seq FROM agboss_pauses WHERE seq > $1::bigint
         AND status IN ('pending', 'resolved') ORDER BY seq LIMIT $2`,
      [after, limit + 1],
    );
    return pageOf(rows, limit);
  }

  /** One tenant's pauses `filter` selects, after the cursor. */
  async ofTenant(
    tenantId: string,
    filter: PauseFilter,
    after: string,
    limit: number,
  ): Promise<PausePage> {
    const rows = await rowsOf(
      this.pool,
      `SELECT record, seq FROM agboss_pauses WHERE tenant_id = $1 AND seq > $2::bigint
         AND status = ANY($3::text[]) AND ($4::text IS NULL OR channel = $4)
         AND ($5::timestamptz IS NULL OR (expires_at IS NOT NULL AND expires_at < $5))
         ORDER BY seq LIMIT $6`,
      [
        tenantId,
        after,
        [...filter.statuses],
        filter.channel ?? null,
        filter.expiresBefore ?? null,
        limit + 1,
      ],
    );
    return pageOf(rows, limit);
  }

  /** What `deleteClosedBefore(cutoff)` removes, at most `limit`, in the insertion order. */
  async closedBefore(cutoff: Date, limit: number): Promise<readonly PauseRecord[]> {
    const rows = await rowsOf(
      this.pool,
      `SELECT p.record FROM agboss_pauses p WHERE ${REMOVABLE} ORDER BY p.seq LIMIT $2`,
      [cutoff, limit],
    );
    return rows.map(recordOfRow);
  }

  /**
   * Removes what `closedBefore` lists and their mailboxes, in one transaction. The candidates are
   * row-locked first (a notice written to one meanwhile finishes before), and the removal reads the
   * mailboxes after the lock: a pause with a notice just written is kept.
   */
  deleteClosedBefore(cutoff: Date): Promise<void> {
    return inPoolTransaction(this.pool, async (database) => {
      const candidates = KeysOf.parse(
        await rowsOf(
          database,
          `SELECT p.tenant_id, p.pause_id FROM agboss_pauses p
           WHERE p.status IN ('taken', 'cancelled') AND p.resolved_at IS NOT NULL
             AND p.resolved_at < $1 FOR UPDATE OF p`,
          [cutoff],
        ),
      );
      const removed = KeysOf.parse(
        await rowsOf(
          database,
          `DELETE FROM agboss_pauses p WHERE (p.tenant_id, p.pause_id) IN
             (SELECT * FROM unnest($2::text[], $3::text[])) AND ${REMOVABLE}
           RETURNING p.tenant_id, p.pause_id`,
          [cutoff, candidates.map((key) => key.tenant_id), candidates.map((key) => key.pause_id)],
        ),
      );
      await rowsOf(
        database,
        `DELETE FROM agboss_pause_notices WHERE (tenant_id, pause_id) IN
           (SELECT * FROM unnest($1::text[], $2::text[]))`,
        [removed.map((key) => key.tenant_id), removed.map((key) => key.pause_id)],
      );
    });
  }
}
