import { PauseResolution } from "@agboss/core";
import { PauseNoticeKind } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import {
  APPROVED,
  DEADLINE,
  LATER,
  MID,
  NINE,
  RECIPIENTS,
  expiringPauseOf,
  instanceOn,
  seenNowOf,
  pauseOf,
} from "./pause-fixtures.js";

/**
 * What the notices say (agbossjs/agboss#935, #1213): which kinds a late `markSent` writes for a
 * pause closed meanwhile — `answer-not-taken` only for an answer closed untaken — and the facts the
 * reminder's and the extension's notices carry, read as stored.
 */
const database = testDatabase();
const store = (): ReturnType<typeof instanceOn> => instanceOn(database.url());
/** A copy of the instant: the notices carry `Date`s, equal by their time. */
const same = (date: Date): Date => new Date(date.getTime());

interface Stored {
  readonly kind: string;
  readonly writtenAt: string;
  readonly reason?: string;
  readonly closedAt?: string;
  readonly expiresAt?: string;
  readonly previousExpiresAt?: string;
}

/** The notices of the pause by recipient, as stored. */
async function noticesOf(pauseId: string): Promise<Record<string, Stored[]>> {
  const { rows } = await onSchema(
    database.url(),
    "SELECT recipient, notices FROM agboss_pause_notices WHERE pause_id = $1 ORDER BY recipient",
    [pauseId],
  );
  return Object.fromEntries(rows.map((row) => [String(row.recipient), row.notices as Stored[]]));
}

const kindsOf = (notices: Record<string, Stored[]>, recipient: string): string[] =>
  (notices[recipient] ?? []).map((notice) => notice.kind);
const CHANNEL = "channel:refund-approval-channel";
const UNTAKEN = [PauseResolution.Cancelled, PauseResolution.TreeEnded] as const;

describe("the notices a late markSent writes for a pause closed before it", () => {
  it("an answered pause that was taken tells its close, never an untaken answer", async () => {
    await store().findOrCreateByStepKey(pauseOf("answered"));
    await store().resolveByTenantIdAndPauseId("default", "answered", APPROVED, MID, RECIPIENTS);

    await store().markSentByTenantIdAndPauseId("default", "answered", RECIPIENTS);

    const notices = await noticesOf("answered");
    expect(kindsOf(notices, CHANNEL)).toEqual(["closed"]);
    expect(kindsOf(notices, "listener:audit-listener")).toEqual(["opened", "closed"]);
  });

  it.each(UNTAKEN)(
    "a pause %s before an answer tells its close, never an untaken answer",
    async (resolution) => {
      const id = `unanswered-${resolution}`;
      await store().findOrCreateByStepKey(pauseOf(id));
      await store().cancelByTenantIdAndPauseId("default", id, resolution, MID, RECIPIENTS);

      await store().markSentByTenantIdAndPauseId("default", id, RECIPIENTS);

      expect(kindsOf(await noticesOf(id), CHANNEL)).toEqual(["closed"]);
    },
  );

  it.each(UNTAKEN)(
    "an answer closed untaken as %s is told after the close, with its reason and time",
    async (resolution) => {
      const id = `untaken-${resolution}`;
      await store().findOrCreateByStepKey(pauseOf(id));
      await store().resolveByTenantIdAndPauseId("default", id, APPROVED, MID, RECIPIENTS);
      await store().closeUntakenByTenantIdAndPauseId("default", id, resolution, LATER, RECIPIENTS);

      await store().markSentByTenantIdAndPauseId("default", id, RECIPIENTS);

      const { [CHANNEL]: channel = [] } = await noticesOf(id);
      expect(channel.map((notice) => notice.kind)).toEqual(["closed", "answer-not-taken"]);
      expect(channel[1]).toMatchObject({ reason: resolution, closedAt: same(LATER) });
    },
  );
});

describe("the facts of a reminder, an extension, a once-only notice", () => {
  it("the reminder tells the deadline it is for", async () => {
    await store().findOrCreateByStepKey(expiringPauseOf("reminded"));

    await store().remindByTenantIdAndPauseId("default", "reminded", MID, RECIPIENTS);

    const notices = await noticesOf("reminded");
    expect(Object.keys(notices)).toHaveLength(3);
    for (const stored of Object.values(notices))
      expect(stored).toEqual([
        { seq: 1, kind: "expiring", writtenAt: same(MID), expiresAt: same(DEADLINE) },
      ]);
  });

  it("a deadline change with a new reminder moves both, in the record and the columns, and tells both deadlines", async () => {
    const later = new Date("2026-01-05T11:00:00.000Z");
    const remind = new Date("2026-01-05T10:30:00.000Z");
    await store().findOrCreateByStepKey(expiringPauseOf("extended"));

    const extended = await store().changeTimeoutByTenantIdAndPauseId(
      "default",
      "extended",
      {
        expiresAt: same(later),
        previousExpiresAt: same(DEADLINE),
        remindAt: same(remind),
        seen: await seenNowOf(store(), "default", "extended"),
      },
      NINE,
      RECIPIENTS,
    );

    expect(extended).toMatchObject({ expiresAt: same(later), remindAt: same(remind) });
    const { rows } = await onSchema(
      database.url(),
      "SELECT expires_at, remind_at FROM agboss_pauses WHERE pause_id = 'extended'",
    );
    expect(rows).toEqual([{ expires_at: later, remind_at: remind }]);
    expect(await store().findPendingByRemindAtBefore(LATER, 10)).toEqual([extended]);
    for (const stored of Object.values(await noticesOf("extended")))
      expect(stored).toEqual([
        {
          seq: 1,
          kind: "timeout-changed",
          writtenAt: same(NINE),
          expiresAt: same(later),
          previousExpiresAt: same(DEADLINE),
        },
      ]);
  });

  it("a deadline change without a reminder leaves the pause with none", async () => {
    const later = new Date("2026-01-05T11:00:00.000Z");
    await store().findOrCreateByStepKey(expiringPauseOf("extended-plain"));

    const extended = await store().changeTimeoutByTenantIdAndPauseId(
      "default",
      "extended-plain",
      {
        expiresAt: same(later),
        previousExpiresAt: same(DEADLINE),
        seen: await seenNowOf(store(), "default", "extended-plain"),
      },
      NINE,
      RECIPIENTS,
    );

    expect(extended).toMatchObject({ expiresAt: same(later) });
    expect(extended).not.toHaveProperty("remindAt");
    const { rows } = await onSchema(
      database.url(),
      "SELECT remind_at FROM agboss_pauses WHERE pause_id = 'extended-plain'",
    );
    expect(rows).toEqual([{ remind_at: null }]);
  });

  it("markSent and noticeOnce of a pause that is not there answer false", async () => {
    expect(await store().markSentByTenantIdAndPauseId("default", "nowhere", RECIPIENTS)).toBe(
      false,
    );
    expect(
      await store().noticeOnceByTenantIdAndPauseId(
        "default",
        "nowhere",
        PauseNoticeKind.JoinFailed,
        {},
        NINE,
        RECIPIENTS,
      ),
    ).toBe(false);
  });

  it("noticeOnce writes once, only for a sent pause, and says whether it wrote", async () => {
    const once = (): Promise<boolean> =>
      store().noticeOnceByTenantIdAndPauseId(
        "default",
        "once",
        PauseNoticeKind.JoinFailed,
        { errorCode: "E1" },
        NINE,
        RECIPIENTS,
      );
    await store().findOrCreateByStepKey(pauseOf("once"));
    expect(await once()).toBe(false);
    await store().markSentByTenantIdAndPauseId("default", "once", RECIPIENTS);

    expect(await once()).toBe(true);
    expect(await once()).toBe(false);
    expect(kindsOf(await noticesOf("once"), CHANNEL)).toEqual(["join-failed"]);
  });
});
