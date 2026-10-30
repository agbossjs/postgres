import {
  ExecutionLeaseEventKind,
  FencedEffectEventOutcome,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
  type ExecutionLeaseEventRecord,
} from "@agboss/core";
import { z } from "zod";

/**
 * A row of `agboss_execution_lease_events` read back: its `record` column is the record `save`
 * wrote, checked against the three kinds of the lease log (#501) — rows are never trusted.
 */

const Step = z.strictObject({
  nodeId: z.string(),
  visitNumber: z.number().int(),
  idempotencyKey: z.string(),
});

/** What every row carries. */
const base = {
  occurredAt: z.string(),
  tenantId: z.string(),
  rootExecutionId: z.string(),
  executionId: z.string(),
  scopeKey: z.string(),
  token: z.number().int(),
  holderInstanceId: z.string(),
};

const Takeover = z.strictObject({
  ...base,
  kind: z.literal(ExecutionLeaseEventKind.Takeover),
  reason: z.enum(LeaseTakeoverReason),
  previousHolderInstanceId: z.string().optional(),
  previousToken: z.number().int().optional(),
  checkpointId: z.string().optional(),
});

const HandedOver = z.strictObject({
  ...base,
  kind: z.literal(ExecutionLeaseEventKind.HandedOver),
  reason: z.enum(HandOverReason),
  site: z.enum(HandOverSite),
  step: Step,
  observedToken: z.number().int().optional(),
});

const FencedEffect = z.strictObject({
  ...base,
  kind: z.literal(ExecutionLeaseEventKind.FencedEffect),
  name: z.string(),
  outcome: z.enum(FencedEffectEventOutcome),
  step: Step,
  writtenToken: z.number().int().optional(),
  observedToken: z.number().int().optional(),
});

const Record = z.discriminatedUnion("kind", [Takeover, HandedOver, FencedEffect]);

const EventRow = z.object({ record: z.unknown() });

/** The record of a row (`SELECT record …`). */
export const leaseEventOf = (row: unknown): ExecutionLeaseEventRecord =>
  Record.parse(EventRow.parse(row).record);
