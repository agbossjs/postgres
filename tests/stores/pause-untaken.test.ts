import { PauseResolution } from "@agboss/core";
import { minutes } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { APPROVED, LATER, MID, RECIPIENTS, expiringPauseOf, instanceOn } from "./pause-fixtures.js";

/**
 * agbossjs/agboss#935 acceptance (a): `closeUntaken` keeps the first close's facts and only adds the
 * not-taken marker, so the channel hears the same whether it was told before the close or at a late
 * `markSent`: an expiry-decided pause stays `Expired` at its deadline, a human answer `Answered` at
 * the answer's time.
 */
const database = testDatabase();
const CHANNEL = "channel:refund-approval-channel";
const AFTER_DEADLINE = new Date("2026-01-05T10:01:00.000Z");

interface Fact {
  kind: string;
  reason?: string;
  closedAt?: string;
  writtenAt: string;
}

/** The channel's notices of the pause: what it hears. */
async function channelHears(pauseId: string): Promise<Fact[]> {
  const store = instanceOn(database.url());
  const claims = await store.claimNoticesDue(LATER, 10, minutes(5), [CHANNEL]);
  const claim = claims.find((one) => one.mailbox.pauseId === pauseId);
  return (claim?.mailbox.notices ?? []).map(({ kind, reason, closedAt, writtenAt }) => ({
    kind,
    reason,
    closedAt,
    writtenAt,
  }));
}

/** The pause expired with the channel's answer (or answered by a person), then its answer untaken. */
async function untaken(id: string, how: "expiry" | "human", isSentFirst: boolean): Promise<Fact[]> {
  const store = instanceOn(database.url());
  await store.findOrCreateByStepKey(expiringPauseOf(id));
  if (isSentFirst) await store.markSentByTenantIdAndPauseId("default", id, RECIPIENTS);
  if (how === "expiry")
    await store.expireByTenantIdAndPauseId(
      "default",
      id,
      { answer: APPROVED },
      AFTER_DEADLINE,
      RECIPIENTS,
    );
  else await store.resolveByTenantIdAndPauseId("default", id, APPROVED, MID, RECIPIENTS);
  const closed = await store.closeUntakenByTenantIdAndPauseId(
    "default",
    id,
    PauseResolution.TreeEnded,
    LATER,
    RECIPIENTS,
  );
  expect(closed).toMatchObject({ answer: { decision: APPROVED.decision } });
  if (!isSentFirst) await store.markSentByTenantIdAndPauseId("default", id, RECIPIENTS);
  return channelHears(id);
}

describe("closeUntaken keeps the first close's facts", () => {
  for (const how of ["expiry", "human"] as const)
    it(`${how}: the channel hears the same sent first or at a late markSent`, async () => {
      await onSchema(database.url(), "DELETE FROM agboss_pause_notices");
      await onSchema(database.url(), "DELETE FROM agboss_pauses");

      const early = await untaken(`early-${how}`, how, true);
      const late = await untaken(`late-${how}`, how, false);

      const strip = (facts: Fact[]): unknown[] =>
        facts
          .filter((fact) => fact.kind !== "opened")
          .map(({ kind, reason, closedAt }) => ({ kind, reason, closedAt }));
      expect(strip(late)).toEqual(strip(early));
      expect(strip(early)[0]).toEqual(
        how === "expiry"
          ? { kind: "closed", reason: "expired", closedAt: "2026-01-05T10:00:00.000Z" }
          : { kind: "closed", reason: "answered", closedAt: MID.toISOString() },
      );
      expect(strip(early)[1]).toEqual({
        kind: "answer-not-taken",
        reason: "tree-ended",
        closedAt: LATER.toISOString(),
      });
    });
});
