import {
  ExecutionAuditEventKind,
  FencedEffectEventOutcome,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
  OutboundCallEventOutcome,
  OutboundCallStatus,
  type ExecutionAuditEventRecord,
} from "@agboss/core";
import { z } from "zod";
import { unescapedJson } from "../nul-escape.js";

/**
 * A row of `agboss_execution_lease_events` read back: its `record` column is the record `save`
 * wrote, checked against the four kinds of the audit log (#501; outbound calls, agbossjs/agboss#505; business keys and
 * superseded calls and leases, #508) —
 * rows are never trusted.
 */

const Step = z.strictObject({
  nodeId: z.string(),
  visitNumber: z.number().int(),
  idempotencyKey: z.string(),
});

/** A business key's replay of another step's write (agbossjs/agboss#508): that step. */
const Origin = z.strictObject({
  executionId: z.string(),
  nodeId: z.string(),
  visitNumber: z.number().int(),
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
  kind: z.literal(ExecutionAuditEventKind.Takeover),
  reason: z.enum(LeaseTakeoverReason),
  previousHolderInstanceId: z.string().optional(),
  previousToken: z.number().int().optional(),
  checkpointId: z.string().optional(),
});

const HandedOver = z.strictObject({
  ...base,
  kind: z.literal(ExecutionAuditEventKind.HandedOver),
  reason: z.enum(HandOverReason),
  site: z.enum(HandOverSite),
  step: Step,
  observedToken: z.number().int().optional(),
});

const FencedEffect = z.strictObject({
  ...base,
  kind: z.literal(ExecutionAuditEventKind.FencedEffect),
  name: z.string(),
  outcome: z.enum(FencedEffectEventOutcome),
  step: Step,
  writtenToken: z.number().int().optional(),
  replayedFrom: Origin.optional(),
  observedToken: z.number().int().optional(),
});

const OutboundCall = z.strictObject({
  ...base,
  kind: z.literal(ExecutionAuditEventKind.OutboundCall),
  name: z.string(),
  target: z.string(),
  operation: z.string(),
  status: z.enum(OutboundCallStatus),
  attempt: z.number().int(),
  outcome: z.enum(OutboundCallEventOutcome),
  step: Step,
  replayedFrom: Origin.optional(),
  supersededBy: z.number().int().optional(),
  closedLease: z
    .strictObject({
      rootExecutionId: z.string(),
      leaseExecutionId: z.string(),
      token: z.number().int(),
    })
    .optional(),
});

const Record = z.discriminatedUnion("kind", [Takeover, HandedOver, FencedEffect, OutboundCall]);

const EventRow = z.object({ record: z.unknown() });

/** The record of a row (`SELECT record …`). */
export const auditEventOf = (row: unknown): ExecutionAuditEventRecord =>
  Record.parse(unescapedJson(EventRow.parse(row).record));
