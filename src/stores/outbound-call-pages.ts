import type { OutboundCallStatusQuery, Page } from "@agboss/core/stores";
import type { OutboundCallRecord } from "@agboss/core";
import type pg from "pg";
import { z } from "zod";
import { rowsOf } from "../connection/query.js";
import { callRecordOf } from "./outbound-calls/outbound-call-rows.js";

/**
 * The paged listing's arguments, checked at the store's entry (agbossjs/agboss#825): the core's
 * contract case refuses a limit that is no whole number from 1 and a cursor this store never gave.
 */

/** The size of a page when none is asked. */
const DEFAULT_PAGE = 100;

/** `limit` as asked: a whole number from 1 — `0`, a fraction, `NaN` or a negative one is a `RangeError`. */
export function pageLimitOf(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE;
  if (Number.isSafeInteger(limit) && limit >= 1) return limit;
  throw new RangeError(`a page's limit is a whole number of calls from 1, got ${String(limit)}`);
}

/** The id a cursor of this store names: a whole number from 1, as it handed it out. */
export function idOfCursor(cursor: string): string {
  if (/^[1-9][0-9]{0,18}$/u.test(cursor)) return cursor;
  throw new RangeError("the cursor is not one this store gave: pass the next of one of its pages");
}

/**
 * A row of a page (agbossjs/agboss#825): its id — an identity `bigint`, from 1, as text: the cursor
 * the page hands out, checked when it comes back (`idOfCursor`) — and its record.
 */
const PagedRow = z.object({ id: z.string(), record: z.unknown() });

/**
 * A page of a tenant's calls in `status`: keyset on the identity `id` — a row keeps its id while it
 * lives, an id is never reused — on the index `(tenant_id, status, id)`; the cursor is the page's
 * last id, as text (a `bigint`).
 */
export async function callsPageOf(
  pool: pg.Pool,
  query: OutboundCallStatusQuery,
): Promise<Page<OutboundCallRecord>> {
  const { tenantId, status, cursor } = query;
  const limit = pageLimitOf(query.limit);
  const rows = await rowsOf(
    pool,
    "SELECT id::text AS id, record FROM agboss_outbound_calls WHERE tenant_id = $1 AND status = $2 AND id > $3::bigint ORDER BY id LIMIT $4",
    [tenantId, status, cursor === undefined ? "0" : idOfCursor(cursor), limit + 1],
  );
  const page = rows.slice(0, limit).map((row) => PagedRow.parse(row));
  const items = page.map((row) => callRecordOf(row));
  const last = page.at(-1);
  return last === undefined || rows.length <= limit ? { items } : { items, nextCursor: last.id };
}
