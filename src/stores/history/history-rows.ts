import type { ExecutionHistoryRecord } from "@agboss/core";
import { executionHistoryRecordOfJson } from "@agboss/core/stores";
import { z } from "zod";
import { unescapedJson } from "../nul-escape.js";

/**
 * A row of `agboss_execution_history` read back: its `record` column is the record `save` wrote, or
 * 0.1.0's. The core reads it (#934): the fields the history is found and exported by are checked, and
 * so is every pause of the record and of its children, at any depth. A row that is not one fails with
 * `StoredNamesUnreadableError`, naming the ids and the field, never half-read.
 */
const HistoryRow = z.object({ record: z.unknown() });

/** The record of a row (`SELECT record …`). */
export const historyRecordOf = (row: unknown): ExecutionHistoryRecord =>
  executionHistoryRecordOfJson(unescapedJson(HistoryRow.parse(row).record));
