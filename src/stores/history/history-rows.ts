import { ExecutionHistoryStatus, type ExecutionHistoryRecord } from "@agboss/core";
import { z } from "zod";

/**
 * A row of `agboss_execution_history` read back: its `record` column is the record `save` wrote,
 * checked for the fields the history is found and exported by — the rest passed through as written
 * (the framework wrote it). A row that is not one fails loudly, never half-read.
 */

const text = z.string();

const StoredHistoryRecord = z.looseObject({
  executionId: text,
  rootExecutionId: text,
  threadId: text,
  tenantId: text,
  application: z.looseObject({ name: text, version: text, instanceId: text }),
  workflow: z.looseObject({ name: text, version: text }),
  status: z.enum(ExecutionHistoryStatus),
  startedAt: text,
  endedAt: text.optional(),
  start: z.looseObject({ name: text, kind: text }),
  contexts: z.looseObject({
    tenant: z.record(text, z.unknown()),
    execution: z.record(text, z.unknown()),
  }),
});

const HistoryRow = z.object({ record: z.unknown() });

const isHistoryRecord = (value: unknown): value is ExecutionHistoryRecord =>
  StoredHistoryRecord.safeParse(value).success;

/** The record of a row (`SELECT record …`). */
export function historyRecordOf(row: unknown): ExecutionHistoryRecord {
  const { record } = HistoryRow.parse(row);
  if (!isHistoryRecord(record))
    throw new Error(`a stored execution history record is not readable: ${JSON.stringify(record)}`);
  return record;
}
