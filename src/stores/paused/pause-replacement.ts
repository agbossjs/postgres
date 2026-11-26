import { PauseResolution, PauseStatus, type PauseRecord } from "@agboss/core";

/**
 * The pause a reassignment replaces (agbossjs/agboss#946, #1307), restated from the core's
 * `reassignedPause` (`pause-replacement.ts`), which no public entry exports. The pause that takes
 * its place is the core's `replacementPause` and its step key `replacementStepKeyOf`, both from
 * `@agboss/core/stores`: the limits it carries are the old record's, narrowed by the destination.
 */

/** The pause moved to a replacement: `Cancelled`, `Reassigned`, pointing at it. */
export const reassignedPause = (
  pause: PauseRecord,
  replacementId: string,
  at: Date,
): PauseRecord => ({
  ...pause,
  status: PauseStatus.Cancelled,
  resolution: PauseResolution.Reassigned,
  resolvedAt: at.toISOString(),
  reassignedTo: replacementId,
});
