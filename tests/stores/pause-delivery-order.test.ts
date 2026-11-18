import { PauseResolution } from "@agboss/core";
import { minutes } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { MID, instanceOn, pauseOf } from "./pause-fixtures.js";

/**
 * The order and the ends of delivery (agbossjs/agboss#935, #1213): the claims come oldest due
 * first and the stale mailboxes oldest head first whatever order the statement returned them in
 * (rows inserted newest first, and oldest first), an acknowledged last notice releases the claim,
 * and a claim for no receiver is none.
 */
const database = testDatabase();
const CLAIM_FOR = minutes(5);
const AUDIT = "listener:audit-listener";
const LISTENER_ONLY = { listeners: ["audit-listener"] };
const at = (time: string): string => `2026-01-05T${time}:00.000Z`;
const NOON = new Date(at("12:00"));

/** Pauses `ids` asked at `times` (so their mailboxes are due then), in this order, each sent. */
async function sentAt(ids: readonly string[], times: readonly string[]): Promise<void> {
  const store = instanceOn(database.url());
  await onSchema(database.url(), "DELETE FROM agboss_pause_notices");
  await onSchema(database.url(), "DELETE FROM agboss_pauses");
  for (const [index, id] of ids.entries()) {
    await store.findOrCreateByStepKey({ ...pauseOf(id), askedAt: at(times[index] ?? "09:00") });
    await store.markSentByTenantIdAndPauseId("default", id, LISTENER_ONLY);
  }
}

const IN_ORDERS = [
  ["newest inserted first", ["a", "b", "c"], ["09:30", "09:20", "09:10"], ["c", "b", "a"]],
  ["oldest inserted first", ["d", "e", "f"], ["09:10", "09:20", "09:30"], ["d", "e", "f"]],
  ["the middle first", ["g", "h", "i"], ["09:20", "09:10", "09:30"], ["h", "g", "i"]],
] as const;

describe("the order of a claim and of the stale", () => {
  it.each(IN_ORDERS)("claims, %s, come oldest due first", async (_how, ids, times, expected) => {
    await sentAt(ids, times);

    const claims = await instanceOn(database.url()).claimNoticesDue(NOON, 10, CLAIM_FOR, [AUDIT]);

    expect(claims.map((claim) => claim.mailbox.pauseId)).toEqual(expected);
  });

  it.each(IN_ORDERS)(
    "the stale, %s, are set aside oldest head first",
    async (_how, ids, times, expected) => {
      await sentAt(ids, times);

      const aside = await instanceOn(database.url()).setAsideStaleNoticesBefore(
        NOON,
        NOON,
        "stale",
        10,
      );

      expect(aside.map((mailbox) => mailbox.pauseId)).toEqual(expected);
      expect(aside.every((mailbox) => mailbox.recipient === AUDIT)).toBe(true);
    },
  );

  it("a claim for no receiver claims nothing", async () => {
    await sentAt(["a"], ["09:00"]);

    expect(await instanceOn(database.url()).claimNoticesDue(NOON, 10, CLAIM_FOR, [])).toEqual([]);
  });
});

describe("a claim's acknowledgements and renewals", () => {
  it("the last notice's acknowledgement releases the claim: the answer is none", async () => {
    await sentAt(["a"], ["09:00"]);
    const store = instanceOn(database.url());
    await store.cancelByTenantIdAndPauseId(
      "default",
      "a",
      PauseResolution.Cancelled,
      MID,
      LISTENER_ONLY,
    );
    const [claim] = await store.claimNoticesDue(NOON, 10, CLAIM_FOR, [AUDIT]);
    if (claim === undefined) throw new Error("the mailbox was not claimed");
    expect(claim.mailbox.notices.map((notice) => notice.kind)).toEqual(["opened", "closed"]);

    const next = await store.ackNotice(claim, MID);

    expect(next).toMatchObject({ token: claim.token, mailbox: { delivered: 1 } });
    expect(next?.mailbox.headWrittenAt).toBe(MID.toISOString());
    expect(await store.ackNotice(claim, MID)).toBeUndefined();
    expect(await store.countNotices()).toEqual({ live: 0, dead: 0 });
  });

  it("a renewal answers the claim held longer, with the same token", async () => {
    await sentAt(["a"], ["09:00"]);
    const store = instanceOn(database.url());
    const [claim] = await store.claimNoticesDue(MID, 10, CLAIM_FOR, [AUDIT]);
    if (claim === undefined) throw new Error("the mailbox was not claimed");
    const later = new Date(MID.getTime() + 60_000);

    const renewed = await store.renewNotice(claim, later, CLAIM_FOR);

    expect(renewed).toMatchObject({
      token: claim.token,
      until: new Date(later.getTime() + CLAIM_FOR),
    });
    expect(await store.renewNotice(claim, new Date(NOON.getTime()), CLAIM_FOR)).toBeUndefined();
  });
});
