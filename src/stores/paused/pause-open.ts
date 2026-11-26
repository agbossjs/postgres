import { PauseStatus, type PauseRecord } from "@agboss/core";

/**
 * When a pause takes a change, restated from the core's pure transitions (`pause-transitions.ts`),
 * which no public entry exports: the instants are ISO 8601 texts on the application's `Clock`, so
 * they compare as time; a pause with no deadline never reaches one.
 */

/** Past any ISO 8601 text: the deadline of a pause that has none. */
const NEVER = "￿";

/** Whether a pending pause takes a change at `at`: no deadline, or one after it (I2). */
export const isOpenAt = (pause: PauseRecord, at: Date): boolean =>
  pause.status === PauseStatus.Pending && (pause.expiresAt ?? NEVER) > at.toISOString();

/** Whether a pending pause's deadline is at or before `at`. */
export const isDueAt = (pause: PauseRecord, at: Date): boolean =>
  pause.status === PauseStatus.Pending && (pause.expiresAt ?? NEVER) <= at.toISOString();

/**
 * Whether a deadline a change sets keeps the cap (`maxExpiresAt` of the record, narrowed by a move):
 * with a cap, only a deadline at or before it does — none at all is past any cap. The core's
 * `isWithinCap`, judged here atomically with the write, over the record read under the row lock.
 */
export const isWithinCap = (
  maxExpiresAt: string | undefined,
  expiresAt: string | undefined,
): boolean => maxExpiresAt === undefined || (expiresAt !== undefined && expiresAt <= maxExpiresAt);

/** How many entries of `action` a pause's chain of custody holds. */
export const countOf = (
  pause: Pick<PauseRecord, "trail">,
  action: PauseRecord["trail"][number]["action"],
): number => pause.trail.filter((entry) => entry.action === action).length;
