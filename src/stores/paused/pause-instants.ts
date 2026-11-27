import type { PausedExecution } from "@agboss/core";
import { assertValidInstant } from "@agboss/core/stores";

/**
 * The times the package is about to bind or write outside the core's own rules (the answer log's is the core's `assertPauseAnswerInstants`) (agbossjs/agboss#1307):
 * an Invalid Date is `null` in JSON, throws in `toISOString()` and is a syntax error as a
 * `timestamptz` parameter, so each is refused first — `StoreError.UnreadableRecord` naming the field,
 * never the value, nothing written. The pause itself is checked by the core's `assertPauseInstants`.
 */

/** The deadlines of the pauses a paused run waits on: `JSON.stringify` would write a bad one as `null`. */
export function assertPausedRunInstants(run: PausedExecution["run"]): void {
  for (const [index, pending] of run.pending.entries())
    assertValidInstant(pending.expiresAt, `pending[${String(index)}].expiresAt`, "paused run");
}

/** The times a scan or a mailbox statement binds, each by the name the caller knows it by. */
export function assertInstants(
  record: string,
  instants: Readonly<Record<string, Date | undefined>>,
): void {
  for (const [field, instant] of Object.entries(instants))
    assertValidInstant(instant, field, record);
}
