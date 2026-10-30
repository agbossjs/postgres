import { randomUUID } from "node:crypto";
import { z } from "zod";
import { changesOf, firstRowOf, rowsOf, type Queryable } from "../../connection/query.js";
import { escapedText, unescapedText } from "../nul-escape.js";
import {
  RECORD_COLUMNS,
  recordsOf,
  type NewSummaryRecord,
  type StoredRecord,
  type StoredSummary,
} from "./record-rows.js";

/**
 * Conversation memory on the records (#77, #120 PR 3): the turns a compaction has not summarised,
 * the turns before one, a turn's position, and each compaction's summaries of a thread — a turn's
 * place is its record's `seq`.
 */

const SummaryRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  thread_id: z.string(),
  workflow: z.string(),
  compaction: z.string(),
  from_record_id: z.string(),
  to_record_id: z.string(),
  turns: z.number(),
  text: z.string().transform(unescapedText),
  cost_usd: z.number(),
  created_at: z.date(),
});

const CountRow = z.object({ count: z.number() });

const summaryOf = (row: unknown): StoredSummary => {
  const r = SummaryRow.parse(row);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    threadId: r.thread_id,
    bundle: r.workflow,
    compaction: r.compaction,
    fromTernId: r.from_record_id,
    toTernId: r.to_record_id,
    turns: r.turns,
    text: r.text,
    costUsd: r.cost_usd,
    createdAt: r.created_at.toISOString(),
  };
};

/** The `seq` of a record (`NULL` for an unknown id). */
const SEQ_OF = (parameter: string): string =>
  `(SELECT seq FROM agboss_execution_records WHERE id = ${parameter})`;

/** The thread's records after the compaction's last summary, oldest first. */
export async function uncoveredRecords(
  database: Queryable,
  tenantId: string,
  threadId: string,
  compaction: string,
): Promise<StoredRecord[]> {
  return recordsOf(
    await rowsOf(
      database,
      `SELECT ${RECORD_COLUMNS} FROM agboss_execution_records WHERE tenant_id = $1
       AND thread_id = $2 AND seq > COALESCE((SELECT max(to_seq) FROM agboss_execution_summaries
         WHERE tenant_id = $1 AND thread_id = $2 AND compaction = $3), 0)
       ORDER BY seq`,
      [tenantId, threadId, compaction],
    ),
  );
}

/** Up to `limit` records of the thread right before `recordId`, oldest first. */
export async function recordsBefore(
  database: Queryable,
  tenantId: string,
  threadId: string,
  recordId: string,
  limit: number,
): Promise<StoredRecord[]> {
  return recordsOf(
    await rowsOf(
      database,
      `SELECT * FROM (SELECT seq, ${RECORD_COLUMNS} FROM agboss_execution_records
         WHERE tenant_id = $1 AND thread_id = $2 AND seq < ${SEQ_OF("$3")}
         ORDER BY seq DESC LIMIT $4) previous ORDER BY seq`,
      [tenantId, threadId, recordId, limit],
    ),
  );
}

/** The 1-based position of a record in its thread. */
export async function turnNumberOf(
  database: Queryable,
  tenantId: string,
  threadId: string,
  recordId: string,
): Promise<number> {
  const row = await firstRowOf(
    database,
    `SELECT count(*)::integer AS count FROM agboss_execution_records
     WHERE tenant_id = $1 AND thread_id = $2 AND seq <= ${SEQ_OF("$3")}`,
    [tenantId, threadId, recordId],
  );
  return CountRow.parse(row).count;
}

/** Adds a summary of a run of turns: its bounds kept as their records' `seq`. */
export async function addSummary(
  database: Queryable,
  summary: NewSummaryRecord,
  now: Date,
): Promise<StoredSummary> {
  const stored: StoredSummary = { ...summary, id: randomUUID(), createdAt: now.toISOString() };
  await changesOf(
    database,
    `INSERT INTO agboss_execution_summaries (id, tenant_id, thread_id, workflow, compaction,
       from_record_id, to_record_id, from_seq, to_seq, turns, text, cost_usd, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${SEQ_OF("$6")}, ${SEQ_OF("$7")}, $8, $9, $10, $11)`,
    [
      stored.id,
      stored.tenantId,
      stored.threadId,
      stored.bundle,
      stored.compaction,
      stored.fromTernId,
      stored.toTernId,
      stored.turns,
      escapedText(stored.text),
      stored.costUsd,
      now,
    ],
  );
  return stored;
}

/** The compaction's newest `limit` summaries of the thread, oldest first. */
export async function latestSummariesOf(
  database: Queryable,
  tenantId: string,
  threadId: string,
  compaction: string,
  limit: number,
): Promise<StoredSummary[]> {
  const rows = await rowsOf(
    database,
    `SELECT * FROM (SELECT * FROM agboss_execution_summaries
       WHERE tenant_id = $1 AND thread_id = $2 AND compaction = $3
       ORDER BY to_seq DESC LIMIT $4) newest ORDER BY to_seq`,
    [tenantId, threadId, compaction, limit],
  );
  return rows.map(summaryOf);
}

/** How many summaries the compaction keeps of the thread. */
export async function summaryCountOf(
  database: Queryable,
  tenantId: string,
  threadId: string,
  compaction: string,
): Promise<number> {
  const row = await firstRowOf(
    database,
    `SELECT count(*)::integer AS count FROM agboss_execution_summaries
     WHERE tenant_id = $1 AND thread_id = $2 AND compaction = $3`,
    [tenantId, threadId, compaction],
  );
  return CountRow.parse(row).count;
}
