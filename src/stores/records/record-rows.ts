import type { ExecutionRecordRepository } from "@agboss/core";
import { z } from "zod";

/**
 * The shapes `ExecutionRecordRepository` reads and writes, derived from its public signatures —
 * `@agboss/core` names them (`Tern`, `NewTern`, `TernOutcome`, `Summary`, …) but does not export
 * them — and the rows of `agboss_execution_records`, validated on the way out.
 */
type Records = ExecutionRecordRepository;

/** One execution's record as the repository gives it (the core's `Tern`). */
export type StoredRecord = Awaited<ReturnType<Records["append"]>>;
/** A record to append (the core's `NewTern`). */
export type NewRecord = Parameters<Records["append"]>[0];
/** What completing a record changes (the core's `TernOutcome`). */
export type RecordOutcome = Parameters<Records["complete"]>[1];
/** A thread to create. */
export type NewThreadRecord = Parameters<Records["createThread"]>[0];
/** A memory summary of a thread's turns (the core's `Summary`). */
export type StoredSummary = Awaited<ReturnType<Records["addSummary"]>>;
/** A summary to add (the core's `NewSummary`). */
export type NewSummaryRecord = Parameters<Records["addSummary"]>[0];
/** A resolved config first seen under a version (the core's `ConfigSnapshot`). */
export type StoredConfigSnapshot = Awaited<ReturnType<Records["configSnapshots"]>>[number];
/** Mean score and cost of one prompt version (the core's `VersionScore`). */
export type StoredVersionScore = Awaited<ReturnType<Records["summary"]>>[number];
/** A resolved pause as the permanent log keeps it. */
export type PauseAnswer = Parameters<Records["savePauseAnswer"]>[2];

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

const RecordRow = z.object({
  id: z.string(),
  run_id: z.string().nullable(),
  tenant_id: z.string(),
  thread_id: z.string(),
  workflow: z.string(),
  created_at: z.date(),
  task: z.string(),
  reply_with: z.string(),
  status: z.enum(STATUSES),
  stop_reason: z.string(),
  route: z.array(z.string()),
  steps: z.array(z.object({ agent: z.string(), content: z.string() })),
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
  outcome.replyWith,
  outcome.status,
  outcome.stopReason,
  JSON.stringify(outcome.route),
  JSON.stringify(outcome.steps),
  outcome.costUsd,
];
