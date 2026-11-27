import type { PauseRecord } from "@agboss/core";
import type { PauseFilter, PausePage, PauseScanAfter } from "@agboss/core/stores";
import type pg from "pg";
import { z } from "zod";
import { rowsOf } from "../../connection/query.js";
import { inLongTransaction } from "../../connection/transaction.js";
import { assertInstants } from "./pause-instants.js";
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

/**
 * The retention's reads, each a constant of its own so the mutation shard drops it
 * (agbossjs/agboss#1302): the status of what is removable (a pause resolved and not yet taken is
 * neither removed nor locked), the replacement and the mailboxes of the pause itself (another
 * tenant's or another pause's do not keep it), and the candidates' row lock.
 */
const CLOSED = "AND p.status IN ('taken', 'cancelled')";
const OF_PAUSE_REPLACEMENT = "AND r.tenant_id = p.tenant_id";
const OF_PAUSE_MAILBOXES = "AND n.tenant_id = p.tenant_id AND n.pause_id = p.pause_id";
const CANDIDATE_LOCK = "FOR UPDATE OF p";

/**
 * What the retention removes: closed, resolved before `$1` (a pause never resolved has no
 * `resolved_at`, which is never before anything), with no live mailbox (I11).
 */
const REMOVABLE = `p.resolved_at < $1 ${CLOSED}
  AND NOT (p.record ? 'reassignedTo' AND EXISTS (SELECT 1 FROM agboss_pauses r
    WHERE r.pause_id = p.record->>'reassignedTo' ${OF_PAUSE_REPLACEMENT}))
  AND NOT EXISTS (SELECT 1 FROM agboss_pause_notices n
    WHERE NOT n.is_dead AND n.delivered < jsonb_array_length(n.notices) ${OF_PAUSE_MAILBOXES})`;

const KeysOf = z.array(z.object({ tenant_id: z.string(), pause_id: z.string() }));

/** The page of the first `limit` of `rows` (read with one more); `next` only when more follow. */
function pageOf(rows: readonly unknown[], limit: number): PausePage {
  const sequenced = rows.map((row) => SequencedRow.parse(row));
  const page = sequenced.slice(0, limit);
  const last = page.at(-1)?.seq; // undefined only for an empty page, which has no more after it
  return { pauses: page.map(recordOfRow), ...(sequenced.length > limit ? { next: last } : {}) };
}

export class PauseScans {
  constructor(private readonly pool: pg.Pool) {}

  /** `Pending` pauses with `column ≤ at`, by `(column, tenant, id)`, on the column's partial index. */
  async pendingDue(
    column: "expires_at" | "remind_at",
    at: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    assertInstants("pause scan", { at, after: after?.at });
    // the keyset (agbossjs/agboss#1070): past the last pause of the page before, in the scan's order
    const rows = await rowsOf(
      this.pool,
      `SELECT record FROM agboss_pauses WHERE status = 'pending' AND ${column} IS NOT NULL
         AND ${column} <= $1
         AND ($3::timestamptz IS NULL OR (${column}, tenant_id COLLATE "C", pause_id COLLATE "C")
           > ($3::timestamptz, $4::text COLLATE "C", $5::text COLLATE "C"))
         ORDER BY ${column}, tenant_id COLLATE "C", pause_id COLLATE "C" LIMIT $2`,
      [at, limit, after?.at ?? null, after?.tenantId ?? null, after?.pauseId ?? null],
    );
    return rows.map(recordOfRow);
  }

  /**
   * The replacements of a reassignment still `Pending` and unsent, asked before `cutoff`, by
   * `(askedAt, tenant, pause)` with the keyset (agbossjs/agboss#946), on the partial index of 0035.
   * The index and the compare are on the record's TEXT `askedAt` (`COLLATE "C"`, canonical ISO, so
   * the text orders as the instant): the cutoff and the keyset's time are bound as
   * `toISOString()` texts, never as `Date`s (node-postgres writes a `Date` in the process's local
   * time with an offset, which does not sort as the instant).
   */
  async reassignedUnsentBefore(
    cutoff: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    assertInstants("pause scan", { cutoff, after: after?.at });
    const rows = await rowsOf(
      this.pool,
      `SELECT record FROM agboss_pauses
       WHERE status = 'pending' AND record ? 'reassignedFrom' AND record->>'isSent' = 'false'
         AND (record->>'askedAt') COLLATE "C" < $1::text COLLATE "C"
         AND ($3::text IS NULL OR
           ((record->>'askedAt') COLLATE "C", tenant_id COLLATE "C", pause_id COLLATE "C")
             > ($3::text COLLATE "C", $4::text COLLATE "C", $5::text COLLATE "C"))
       ORDER BY (record->>'askedAt') COLLATE "C", tenant_id COLLATE "C", pause_id COLLATE "C"
       LIMIT $2`,
      [
        cutoff.toISOString(),
        limit,
        after?.at.toISOString() ?? null,
        after?.tenantId ?? null,
        after?.pauseId ?? null,
      ],
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
  ofTenant(
    tenantId: string,
    filter: PauseFilter,
    after: string,
    limit: number,
  ): Promise<PausePage> {
    return this.#page(tenantId, filter, after, limit);
  }

  /** Every tenant's pauses `filter` selects, after the cursor (`app.listPauses({ allTenants: true })`). */
  ofAllTenants(filter: PauseFilter, after: string, limit: number): Promise<PausePage> {
    return this.#page(undefined, filter, after, limit);
  }

  /**
   * The page of the pauses `filter` selects — of `tenantId`, or (none given) of every tenant — by
   * `seq`. Only the conditions the filter names are in the statement, so each reads its own index:
   * the tenant's by `agboss_pauses_by_tenant`, an assignee by the GIN on the record's `assignees`
   * (`@>`: any member of a pool matches), an external reference and a channel by theirs, a status
   * alone by `agboss_pauses_by_status`.
   */
  async #page(
    tenantId: string | undefined,
    filter: PauseFilter,
    after: string,
    limit: number,
  ): Promise<PausePage> {
    assertInstants("pause filter", { expiresBefore: filter.expiresBefore });
    const values: unknown[] = [after];
    const clauses = ["seq > $1::bigint"];
    const add = (clause: (placeholder: string) => string, value: unknown): void => {
      values.push(value);
      clauses.push(clause(`$${String(values.length)}`));
    };
    if (tenantId !== undefined) add((at) => `tenant_id = ${at}`, tenantId);
    add((at) => `status = ANY(${at}::text[])`, [...filter.statuses]);
    if (filter.target !== undefined) add((at) => `target = ${at}::text`, filter.target);
    if (filter.expiresBefore !== undefined)
      add(
        (at) => `expires_at IS NOT NULL AND expires_at < ${at}::timestamptz`,
        filter.expiresBefore,
      );
    if (filter.channel !== undefined)
      add((at) => `(record ->> 'channel') = ${at}::text`, filter.channel);
    if (filter.assignee !== undefined)
      add((at) => `(record -> 'assignees') @> jsonb_build_array(${at}::text)`, filter.assignee);
    if (filter.externalRef !== undefined)
      add((at) => `(record ->> 'externalRef') = ${at}::text`, filter.externalRef);
    values.push(limit + 1);
    const rows = await rowsOf(
      this.pool,
      `SELECT record, seq FROM agboss_pauses WHERE ${clauses.join(" AND ")}
         ORDER BY seq LIMIT $${String(values.length)}`,
      values,
    );
    return pageOf(rows, limit);
  }

  /**
   * A page of what `deleteClosedBefore(cutoff)` removes, in the insertion order (`seq`), after the
   * cursor — the retention's log repair reads every page before the one removal (#939).
   */
  async closedBefore(cutoff: Date, after: string, limit: number): Promise<PausePage> {
    assertInstants("pause scan", { cutoff });
    const rows = await rowsOf(
      this.pool,
      `SELECT p.record, p.seq FROM agboss_pauses p WHERE p.seq > $3::bigint AND ${REMOVABLE}
       ORDER BY p.seq LIMIT $2`,
      [cutoff, limit + 1, after],
    );
    return pageOf(rows, limit);
  }

  /**
   * Removes what `closedBefore` lists and their mailboxes, in one transaction. The candidates are
   * row-locked first (a notice written to one meanwhile finishes before), and the removal reads the
   * mailboxes after the lock: a pause with a notice just written is kept.
   */
  async deleteClosedBefore(cutoff: Date): Promise<void> {
    assertInstants("pause scan", { cutoff });
    await inLongTransaction(this.pool, async (database) => {
      const candidates = KeysOf.parse(
        await rowsOf(
          database,
          `SELECT p.tenant_id, p.pause_id FROM agboss_pauses p
           WHERE p.resolved_at < $1 ${CLOSED} ${CANDIDATE_LOCK}`,
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
