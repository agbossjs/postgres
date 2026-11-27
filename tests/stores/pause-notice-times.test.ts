import { PauseNoticeKind, StoreError } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { claimDue, UNREADABLE_MAILBOX } from "../../src/stores/paused/pause-delivery-rows.js";
import { mailboxRowOf } from "../../src/stores/paused/pause-notice-rows.js";
import { mailboxOf } from "../../src/stores/paused/pause-notice-rows.js";
import { recordedPool } from "./recorded-pool.js";

/**
 * The notices' times as the `notices` jsonb keeps them (agbossjs/agboss#1307, P6b): canonical ISO
 * texts, read back as `Date`s by the core's `instantOfText` and in no other spelling; a mailbox with
 * one that does not read is set aside at the claim, the others claimed. The mailbox row's actor and
 * masked reason are kept as written (#1099).
 */
const WRITTEN = new Date("2026-01-05T09:00:00.000Z");
const ROW = {
  tenant_id: "default",
  pause_id: "p",
  recipient: "listener:audit-listener",
  delivered: 0,
  attempts: 0,
  next_attempt_at: WRITTEN,
  is_dead: false,
  problem: null,
  claim_token: null,
  claimed_until: null,
};
const withNotices = (notices: readonly object[]) => mailboxRowOf({ ...ROW, notices });

describe("a mailbox row's notices", () => {
  it("reads every time as a Date, each only when it is there", () => {
    const stored = withNotices([
      {
        seq: 1,
        kind: PauseNoticeKind.TimeoutChanged,
        writtenAt: "2026-01-05T09:00:00.123Z",
        closedAt: "2026-01-05T09:01:00.000Z",
        expiresAt: "2026-01-05T12:00:00.000Z",
        previousExpiresAt: "2026-01-05T10:00:00.000Z",
        actor: { id: "manager-17", orgId: "acme" },
        changeReason: "escalated",
      },
      { seq: 2, kind: PauseNoticeKind.Opened, writtenAt: "2026-01-05T09:00:00.000Z" },
    ]);

    expect(stored.notices[0]).toStrictEqual({
      seq: 1,
      kind: PauseNoticeKind.TimeoutChanged,
      writtenAt: new Date("2026-01-05T09:00:00.123Z"),
      closedAt: new Date("2026-01-05T09:01:00.000Z"),
      expiresAt: new Date("2026-01-05T12:00:00.000Z"),
      previousExpiresAt: new Date("2026-01-05T10:00:00.000Z"),
      actor: { id: "manager-17", orgId: "acme" },
      changeReason: "escalated",
    });
    expect(stored.notices[1]).toStrictEqual({
      seq: 2,
      kind: PauseNoticeKind.Opened,
      writtenAt: WRITTEN,
    });
    expect(mailboxOf(stored).headWrittenAt).toEqual(new Date("2026-01-05T09:00:00.123Z"));
  });

  for (const [field, text] of [
    ["writtenAt", "2026-01-05 09:00:00+02"],
    ["writtenAt", "2026-01-05T11:00:00.000+02:00"],
    ["closedAt", "2026-01-05T09:00:00Z"],
    ["expiresAt", "tomorrow"],
    ["previousExpiresAt", ""],
  ] as const)
    it(`${field} "${text}" is not the canonical spelling: StoreError.UnreadableRecord naming the field`, () => {
      const notice = { seq: 1, kind: PauseNoticeKind.Closed, writtenAt: WRITTEN.toISOString() };

      expect(() => withNotices([{ ...notice, [field]: text }])).toThrow(
        StoreError.UnreadableRecord,
      );
    });

  it("does not quote the text it refused", () => {
    expect.hasAssertions();
    try {
      withNotices([{ seq: 1, kind: "opened", writtenAt: "SECRET-TEXT" }]);
    } catch (error) {
      expect(String(error)).not.toContain("SECRET-TEXT");
      expect(String(error)).toContain("writtenAt");
    }
  });

  it("a kind no code writes is refused", () => {
    expect(() =>
      withNotices([{ seq: 1, kind: "extended", writtenAt: WRITTEN.toISOString() }]),
    ).toThrow();
  });
});

describe("the claim over a mailbox whose time does not read", () => {
  it("sets it aside as unreadable and claims the others", async () => {
    const good = {
      ...ROW,
      claim_token: "t",
      claimed_until: new Date("2026-01-05T09:05:00.000Z"),
      notices: [{ seq: 1, kind: "opened", writtenAt: WRITTEN.toISOString() }],
    };
    const bad = {
      ...good,
      pause_id: "bad",
      notices: [{ seq: 1, kind: "opened", writtenAt: "2026-01-05 09:00:00+02" }],
    };
    const { pool, sent } = recordedPool([[bad, good]]);

    const claims = await claimDue(pool, WRITTEN, 10, 300_000, ["listener:audit-listener"]);

    expect(claims.map((claim) => claim.mailbox.pauseId)).toEqual(["p"]);
    expect(sent[1]?.values).toEqual([
      "default",
      "bad",
      "listener:audit-listener",
      UNREADABLE_MAILBOX,
    ]);
  });

  it("an Invalid Date `at` is refused before the statement", async () => {
    const { pool, sent } = recordedPool();

    await expect(claimDue(pool, new Date(Number.NaN), 10, 1, ["r"])).rejects.toBeInstanceOf(
      StoreError.UnreadableRecord,
    );
    expect(sent).toHaveLength(0);
  });
});
