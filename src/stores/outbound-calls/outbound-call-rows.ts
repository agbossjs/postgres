import { OutboundCallStatus, type FencedEffectKey, type OutboundCallRecord } from "@agboss/core";
import { z } from "zod";
import { escapedJsonOf, escapedText, unescapedJson } from "../nul-escape.js";

/**
 * The rows of `agboss_outbound_calls` (agbossjs/agboss#505, #508): a call's record as `jsonb`, its
 * strings escaped (agbossjs/agboss#521), and where a key's row is — by its step, or by its tenant,
 * name and business key. A row read back is checked field by field: rows are never trusted.
 */

const text = z.string();
const Failure = z.strictObject({ name: text, code: text, message: text });

const StoredCall = z.strictObject({
  rootExecutionId: text,
  executionId: text,
  workflow: text,
  target: text,
  operation: text,
  idempotencyKey: text,
  request: text,
  attempt: z.number().int(),
  attemptOwner: text,
  step: z.strictObject({ nodeId: text, visitNumber: z.number().int() }),
  tenantId: text,
  name: text,
  status: z.enum(OutboundCallStatus),
  result: text.optional(),
  failure: Failure.optional(),
  token: z.number().int(),
  leaseExecutionId: text,
  businessKey: text.optional(),
  fingerprint: text.optional(),
  businessKeyHash: text.optional(),
  recordedAt: text,
  endedAt: text.optional(),
});

const CallRow = z.object({ record: z.unknown() });

/** The record of a row (`SELECT record …`). */
export const callRecordOf = (row: unknown): OutboundCallRecord =>
  StoredCall.parse(unescapedJson(CallRow.parse(row).record));

/** A record (or a part of one) as the `jsonb` parameter that keeps it. */
export const storedJsonOf = (record: Partial<OutboundCallRecord>): string => escapedJsonOf(record);

/**
 * Where `key`'s row is, from parameter `$<from>` on: the condition and its parameters — by its
 * step (`business_key IS NULL`), or by its tenant, name and business key (#508).
 */
export function whereOf(key: FencedEffectKey, from: number): readonly [string, readonly string[]] {
  const [a, b, c] = [from, from + 1, from + 2].map((index) => `$${String(index)}`);
  if (key.businessKey === undefined)
    return [
      `scope_key = ${String(a)} AND idempotency_key = ${String(b)} AND name = ${String(c)} AND business_key IS NULL`,
      [key.scopeKey, escapedText(key.idempotencyKey), key.name],
    ];
  return [
    `tenant_id = ${String(a)} AND name = ${String(b)} AND business_key = ${String(c)}`,
    [key.tenantId, key.name, escapedText(key.businessKey)],
  ];
}
