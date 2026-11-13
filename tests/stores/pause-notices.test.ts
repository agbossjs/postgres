import { PauseResolution } from "@agboss/core";
import type { PauseNoticeClaim } from "@agboss/core/stores";
import { minutes } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { blockedBefore, openTransaction } from "./pause-locks.js";
import { MID, RECIPIENTS, expiringPauseOf, instanceOn, pauseOf } from "./pause-fixtures.js";

/**
 * agbossjs/agboss#936 AC1 on PostgreSQL, what the contract suite cannot reach: the claim is one
 * `FOR UPDATE SKIP LOCKED` statement — two instances claim disjoint mailboxes and a locked one is
 * passed over, never waited for — and a mailbox's notices are delivered once, in order, whoever
 * claims it.
 */
const database = testDatabase();
const CLAIM_FOR = minutes(5);
const ALL = [
  "channel:refund-approval-channel",
  "listener:audit-listener",
  "listener:slack-listener",
];

const empty = async (): Promise<void> => {
  await onSchema(database.url(), "DELETE FROM agboss_pause_notices");
  await onSchema(database.url(), "DELETE FROM agboss_pauses");
};

/** `count` sent pauses, each cancelled: three mailboxes each (opened to the listeners, closed to all). */
async function cancelledPauses(count: number): Promise<void> {
  const store = instanceOn(database.url());
  for (let index = 0; index < count; index += 1) {
    const id = `pause-${String(index).padStart(2, "0")}`;
    await store.findOrCreateByStepKey(pauseOf(id));
    await store.markSentByTenantIdAndPauseId("default", id, RECIPIENTS);
    await store.cancelByTenantIdAndPauseId(
      "default",
      id,
      PauseResolution.Cancelled,
      MID,
      RECIPIENTS,
    );
  }
}

const keyOf = (claim: PauseNoticeClaim): string =>
  `${claim.mailbox.pauseId}/${claim.mailbox.recipient}`;

describe("claiming mailboxes with SKIP LOCKED", () => {
  it("claim with SKIP LOCKED: two pools claim disjoint mailboxes", async () => {
    await empty();
    await cancelledPauses(10);
    const [first, second] = [instanceOn(database.url()), instanceOn(database.url())];

    const [mine, theirs] = await Promise.all([
      first.claimNoticesDue(MID, 15, CLAIM_FOR, ALL),
      second.claimNoticesDue(MID, 15, CLAIM_FOR, ALL),
    ]);

    expect(mine).toHaveLength(15);
    expect(theirs).toHaveLength(15);
    expect(new Set([...mine, ...theirs].map(keyOf)).size).toBe(30);
    expect(await first.claimNoticesDue(MID, 15, CLAIM_FOR, ALL)).toEqual([]);
  });

  it("a mailbox another transaction holds is passed over, not waited for", async () => {
    await empty();
    await cancelledPauses(1);
    const store = instanceOn(database.url());
    const holder = await openTransaction(database.url());
    await holder.query("SELECT 1 FROM agboss_pause_notices WHERE recipient = $1 FOR UPDATE", [
      "listener:audit-listener",
    ]);

    const claiming = store.claimNoticesDue(MID, 10, CLAIM_FOR, ALL);
    const isBlocked = await blockedBefore(database.url(), claiming);
    await holder.query("ROLLBACK");
    await holder.end();

    expect(isBlocked).toBe(false);
    expect((await claiming).map((claim) => claim.mailbox.recipient).sort()).toEqual([
      "channel:refund-approval-channel",
      "listener:slack-listener",
    ]);
  });
});

/** Every notice of one pause's three mailboxes beyond the first: the deadline moved three times. */
async function pausesWithManyNotices(count: number): Promise<void> {
  const store = instanceOn(database.url());
  for (let index = 0; index < count; index += 1) {
    const id = `many-${String(index)}`;
    await store.findOrCreateByStepKey(expiringPauseOf(id));
    await store.markSentByTenantIdAndPauseId("default", id, RECIPIENTS);
    for (const hour of [11, 12, 13])
      await store.extendByTenantIdAndPauseId(
        "default",
        id,
        { expiresAt: `2026-01-05T${String(hour)}:00:00.000Z` },
        MID,
        RECIPIENTS,
      );
  }
}

describe("per-recipient order under concurrent claimers", () => {
  it("each mailbox's notices are delivered once, in order, however the claimers interleave", async () => {
    await empty();
    await pausesWithManyNotices(4);
    const delivered: { key: string; seq: number }[] = [];
    const claimers = Array.from({ length: 4 }, () => instanceOn(database.url()));

    const work = async (store: (typeof claimers)[number]): Promise<void> => {
      while ((await store.countNotices()).live > 0) {
        for (const claim of await store.claimNoticesDue(MID, 2, CLAIM_FOR, ALL)) {
          let held: PauseNoticeClaim | undefined = claim;
          while (held !== undefined) {
            const head = held.mailbox.notices[held.mailbox.delivered];
            delivered.push({ key: keyOf(held), seq: head?.seq ?? 0 });
            held = await store.ackNotice(held, MID);
          }
        }
      }
    };
    await Promise.all(claimers.map(work));

    const keys = [...new Set(delivered.map((one) => one.key))];
    expect(keys).toHaveLength(12);
    for (const key of keys) {
      const seqs = delivered.filter((one) => one.key === key).map((one) => one.seq);
      // listeners: opened + 3 extended; the channel: 3 extended
      expect(seqs).toEqual(key.endsWith("refund-approval-channel") ? [1, 2, 3] : [1, 2, 3, 4]);
    }
  });
});
