import type { ExecutionRecordStatus } from "@agboss/core";
import { rowsOf, type Queryable } from "../../connection/query.js";
import {
  RECORD_COLUMNS,
  RECORD_COLUMNS_OF_R,
  recordsOf,
  type StoredRecord,
} from "./record-rows.js";

/** The reads of records: by thread, by id, by status (recovery), by prompt version. Oldest first. */

/** The newest `limit` records of a thread, oldest first. */
export async function lastRecordsOf(
  database: Queryable,
  tenantId: string,
  threadId: string,
  limit: number,
): Promise<StoredRecord[]> {
  return recordsOf(
    await rowsOf(
      database,
      `SELECT * FROM (SELECT seq, ${RECORD_COLUMNS} FROM agboss_execution_records
         WHERE tenant_id = $1 AND thread_id = $2 ORDER BY seq DESC LIMIT $3) newest ORDER BY seq`,
      [tenantId, threadId, limit],
    ),
  );
}

/** The records of `ids`, in the order they were appended. */
export async function recordsByIds(
  database: Queryable,
  ids: readonly string[],
): Promise<StoredRecord[]> {
  return recordsOf(
    await rowsOf(
      database,
      `SELECT ${RECORD_COLUMNS} FROM agboss_execution_records WHERE id = ANY($1::text[]) ORDER BY seq`,
      [ids],
    ),
  );
}

/** A page of the records with `status` after the record `after` (recovery's look-up, #265 S30). */
export async function recordsByStatus(
  database: Queryable,
  status: ExecutionRecordStatus,
  limit: number,
  after: string | undefined,
): Promise<StoredRecord[]> {
  return recordsOf(
    await rowsOf(
      database,
      `SELECT ${RECORD_COLUMNS} FROM agboss_execution_records WHERE status = $1
       AND seq > COALESCE((SELECT seq FROM agboss_execution_records WHERE id = $2), 0)
       ORDER BY seq LIMIT $3`,
      [status, after ?? null, limit],
    ),
  );
}

/** Original (not replayed) records of a prompt version, a run in flight left out. */
export async function recordsByVersion(
  database: Queryable,
  workflow: string,
  promptVersion: string,
  limit: number,
): Promise<StoredRecord[]> {
  return recordsOf(
    await rowsOf(
      database,
      `SELECT ${RECORD_COLUMNS} FROM agboss_execution_records WHERE workflow = $1
       AND prompt_version = $2 AND replay_of IS NULL AND status <> 'running' ORDER BY seq LIMIT $3`,
      [workflow, promptVersion, limit],
    ),
  );
}

/** Answered records without a score, of one prompt version or of all. */
export async function unscoredRecords(
  database: Queryable,
  workflow: string,
  promptVersion: string | undefined,
  limit: number,
): Promise<StoredRecord[]> {
  return recordsOf(
    await rowsOf(
      database,
      `SELECT ${RECORD_COLUMNS_OF_R} FROM agboss_execution_records r WHERE r.workflow = $1
       AND ($2::text IS NULL OR r.prompt_version = $2) AND r.status = 'answered'
       AND NOT EXISTS (SELECT 1 FROM agboss_execution_scores s WHERE s.record_id = r.id)
       ORDER BY r.seq LIMIT $3`,
      [workflow, promptVersion ?? null, limit],
    ),
  );
}

/** The newest `limit` original answered records of a workflow, oldest first. */
export async function recentOriginalRecords(
  database: Queryable,
  workflow: string,
  limit: number,
): Promise<StoredRecord[]> {
  return recordsOf(
    await rowsOf(
      database,
      `SELECT * FROM (SELECT seq, ${RECORD_COLUMNS} FROM agboss_execution_records
         WHERE workflow = $1 AND replay_of IS NULL AND status = 'answered'
         ORDER BY seq DESC LIMIT $2) newest ORDER BY seq`,
      [workflow, limit],
    ),
  );
}
