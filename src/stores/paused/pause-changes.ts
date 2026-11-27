import type { PauseCancellation, PauseRecord } from "@agboss/core";
import {
  cancelChange,
  closeUntakenChange,
  decideChange,
  expireChange,
  resolveChange,
  type PauseAnswer,
  type PauseExpiry,
  type PauseRecipients,
  type PauseSeen,
  type PauseUntakenResolution,
} from "@agboss/core/stores";
import type pg from "pg";
import { transitioned } from "./pause-transition.js";

/**
 * The closers of a pending pause (agbossjs/agboss#935, #910, #1307): each is the core's pure
 * transition of the pause read under its row lock (`transitioned`) — `resolveChange`, `decideChange`,
 * `cancelChange`, `expireChange`, `closeUntakenChange` — with the notices it plans, written in the
 * one transaction. The deadline (no answer at or after it), the `seen` compare and the status a
 * change starts from are the transition's, never restated here; of an answer and an in-place
 * reassignment, or of two instances, exactly one wins.
 */
export class PauseChanges {
  constructor(private readonly pool: pg.Pool) {}

  /** The pause answered, with the `closed` notice of what it became (an unsent pause's tells no one: I8). */
  resolve(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    recipients: PauseRecipients,
    seen?: PauseSeen,
  ): Promise<PauseRecord | undefined> {
    return transitioned(this.pool, { tenantId, pauseId }, (pause) =>
      resolveChange(pause, answer, at, recipients, seen),
    );
  }

  /** Its channel decided at once: never sent, no notice (I8); whether the decision was recorded. */
  async decide(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    seen: PauseSeen,
  ): Promise<boolean> {
    const decided = await transitioned(this.pool, { tenantId, pauseId }, (pause) =>
      decideChange(pause, answer, at, seen),
    );
    return decided !== undefined;
  }

  /** A cancel or a tree end at or after `expiresAt` records `Expired` instead (I3): the core's rule. */
  cancel(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return transitioned(this.pool, { tenantId, pauseId }, (pause) =>
      cancelChange(pause, resolution, at, recipients),
    );
  }

  /** The deadline passed: the channel's answer, else `Cancelled / Expired`; only while `expiresAt ≤ at`. */
  expire(
    tenantId: string,
    pauseId: string,
    expiry: PauseExpiry,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return transitioned(this.pool, { tenantId, pauseId }, (pause) =>
      expireChange(pause, expiry, at, recipients),
    );
  }

  /** `Resolved → Cancelled` as the not-taken marker, the first close's facts kept in `closedFirst` (#935). */
  closeUntaken(
    tenantId: string,
    pauseId: string,
    resolution: PauseUntakenResolution,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return transitioned(this.pool, { tenantId, pauseId }, (pause) =>
      closeUntakenChange(pause, resolution, at, recipients),
    );
  }
}
