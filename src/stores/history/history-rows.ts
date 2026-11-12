import { ExecutionHistoryStatus, type ExecutionHistoryRecord } from "@agboss/core";
import {
  executionHistoryRecordOfStored,
  type StoredHistoryRecord as StoredHistory,
} from "@agboss/core/stores";
import { z } from "zod";
import { unescapedJson } from "../nul-escape.js";

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

/** The ids that name a stored record in an error: never its contexts (#906 D4: those are the caller's). */
/** ` (tenantId acme, …)`, or nothing when no id is readable. */
const named = (ids: string): string => (ids === "" ? "" : ` (${ids})`);

const idsOf = (value: unknown): string =>
  ["tenantId", "executionId", "threadId"]
    .flatMap((key) => {
      const id: unknown =
        typeof value === "object" && value !== null ? Reflect.get(value, key) : "";
      return typeof id === "string" ? [`${key} ${id}`] : [];
    })
    .join(", ");

/** The record of a row (`SELECT record …`). */
export function historyRecordOf(row: unknown): ExecutionHistoryRecord {
  const record = unescapedJson(HistoryRow.parse(row).record);
  const stored = StoredHistoryRecord.safeParse(record);
  if (!stored.success) {
    const field = [
      ...new Set(stored.error.issues.map((issue) => issue.path.join(".") || "(the value)")),
    ].join(", ");
    throw new Error(
      `a stored execution history record is not readable${named(idsOf(record))}: the field(s) ${field} missing or not what the framework wrote`,
      { cause: stored.error },
    );
  }
  return executionHistoryRecordOfStored(record as StoredHistory);
}
