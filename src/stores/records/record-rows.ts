import type {
  ConfigSnapshot,
  NewSummary,
  NewTern,
  NewThread,
  PauseAnswerRecord,
  Summary,
  Tern,
  TernOutcome,
  VersionScore,
} from "@agboss/core";
import { z } from "zod";
import { escapedJsonOf, escapedText, unescapedText } from "../nul-escape.js";

/**
 * The shapes `ExecutionRecordRepository` reads and writes — the core's own types, exported with its
 * contract (agbossjs/agboss#511) — and the rows of `agboss_execution_records`, validated on the way
 * out.
 */

/** One execution's record as the repository gives it. */
export type StoredRecord = Tern;
/** A record to append. */
export type NewRecord = NewTern;
/** What completing a record changes. */
export type RecordOutcome = TernOutcome;
/** A thread to create. */
export type NewThreadRecord = NewThread;
/** A memory summary of a thread's turns. */
export type StoredSummary = Summary;
/** A summary to add. */
export type NewSummaryRecord = NewSummary;
/** A resolved config first seen under a version. */
export type StoredConfigSnapshot = ConfigSnapshot;
/** Mean score and cost of one prompt version. */
export type StoredVersionScore = VersionScore;
/** A resolved pause as the permanent log keeps it. */
export type PauseAnswer = PauseAnswerRecord;

/** The statuses a record has (`ExecutionRecordStatus`'s values). */
const STATUSES = [
  "running",
  "answered",
  "guarded",
  "failed",
  "paused",
  "queued",
  "written",
] as const satisfies readonly StoredRecord["status"][];

/** The columns a record is read with, in every query. */
export const RECORD_COLUMNS = `id, run_id, tenant_id, thread_id, workflow, created_at, task,
  reply_with, status, stop_reason, route, steps, cost_usd, prompt_version, model_version,
  replay_of, config_version, config_hash`;

/** `RECORD_COLUMNS` of the table aliased `r`. */
export const RECORD_COLUMNS_OF_R = RECORD_COLUMNS.split(",")
  .map((column) => `r.${column.trim()}`)
  .join(", ");

/** A string a column keeps escaped (agbossjs/agboss#521: no U+0000 in PostgreSQL). */
const kept = z.string().transform(unescapedText);

const RecordRow = z.object({
  id: z.string(),
  run_id: z.string().nullable(),
  tenant_id: z.string(),
  thread_id: z.string(),
  workflow: z.string(),
  created_at: z.date(),
  task: kept,
  reply_with: kept,
  status: z.enum(STATUSES),
  stop_reason: kept,
  route: z.array(kept),
  steps: z.array(z.object({ agent: kept, content: kept })),
  cost_usd: z.number(),
  prompt_version: z.string(),
  model_version: z.string(),
  replay_of: z.string().nullable(),
  config_version: z.string().nullable(),
  config_hash: z.string().nullable(),
});

/** A row of `agboss_execution_records` as the record it keeps. */
export function recordOf(row: unknown): StoredRecord {
  const r = RecordRow.parse(row);
  return {
    id: r.id,
    runId: r.run_id,
    threadId: r.thread_id,
    tenantId: r.tenant_id,
    bundle: r.workflow,
    createdAt: r.created_at.toISOString(),
    task: r.task,
    replyWith: r.reply_with,
    status: r.status,
    stopReason: r.stop_reason,
    route: r.route,
    steps: r.steps,
    costUsd: r.cost_usd,
    promptVersion: r.prompt_version,
    modelVersion: r.model_version,
    replayOf: r.replay_of,
    configVersion: r.config_version,
    configHash: r.config_hash,
  };
}

/** The records of rows, in their order. */
export const recordsOf = (rows: readonly unknown[]): StoredRecord[] => rows.map(recordOf);

/** The outcome's columns as statement parameters, in `SET` order. */
export const outcomeParameters = (outcome: RecordOutcome): readonly unknown[] => [
  escapedText(outcome.replyWith),
  outcome.status,
  escapedText(outcome.stopReason),
  escapedJsonOf(outcome.route),
  escapedJsonOf(outcome.steps),
  outcome.costUsd,
];
