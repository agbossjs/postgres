import {
  IdempotencyKeyConflictError,
  type FencedEffectKey,
  type FencedEffectOrigin,
} from "@agboss/core";
import { z } from "zod";

/**
 * Business keys (agbossjs/agboss#508), as the fenced stores compare them: a row found under a
 * key's business key with another fingerprint is `IdempotencyKeyConflictError` (never a replay); a
 * row another step or execution wrote is named as `replayedFrom`. The core's stores do the same
 * with helpers it keeps internal.
 */

/** The step a row was written by. */
export const Origin = z.strictObject({
  executionId: z.string(),
  nodeId: z.string(),
  visitNumber: z.number().int(),
});

/** What a business key's row keeps of the key that wrote it: its fingerprint and its step. */
export const StoredFacts = z.object({
  fingerprint: z.string().nullable(),
  origin: z.unknown(),
});

/** The facts of a stored row, `null` where the key had none. */
export interface RowFacts {
  readonly fingerprint: string | null | undefined;
  readonly origin: unknown;
}

const sameOrigin = (left: FencedEffectOrigin, right: FencedEffectOrigin | undefined): boolean =>
  left.executionId === right?.executionId &&
  left.nodeId === right.nodeId &&
  left.visitNumber === right.visitNumber;

/**
 * The step `key`'s replay names, for a row found under its business key — `undefined` for a step's
 * key, a row of the key's own step or one without its step; another fingerprint throws
 * `IdempotencyKeyConflictError`, with the key's handle and never the key.
 */
export function replayedFromOf(
  key: FencedEffectKey,
  stored: RowFacts,
): FencedEffectOrigin | undefined {
  if (key.businessKey === undefined) return undefined;
  if ((stored.fingerprint ?? undefined) !== key.fingerprint)
    throw new IdempotencyKeyConflictError({ name: key.name, businessKeyHash: key.businessKeyHash });
  if (stored.origin === null || stored.origin === undefined) return undefined;
  const origin = Origin.parse(stored.origin);
  return sameOrigin(origin, key.origin) ? undefined : origin;
}
