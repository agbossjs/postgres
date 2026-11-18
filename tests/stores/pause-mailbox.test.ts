import { PauseNoticeKind } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { mailboxOf, type StoredMailbox } from "../../src/stores/paused/pause-notice-rows.js";

/** The mailbox a receiver sees (agbossjs/agboss#935, #1213): a head and a problem only when there are some. */
const WRITTEN = "2026-01-05T09:00:00.000Z";

const storedWith = (changes: Partial<StoredMailbox>): StoredMailbox => ({
  tenant_id: "default",
  pause_id: "pause-1",
  recipient: "listener:audit-listener",
  notices: [{ seq: 1, kind: PauseNoticeKind.Opened, writtenAt: WRITTEN }],
  delivered: 0,
  attempts: 2,
  next_attempt_at: new Date(WRITTEN),
  is_dead: false,
  problem: null,
  claim_token: null,
  claimed_until: null,
  ...changes,
});

describe("the mailbox of a stored row", () => {
  it("has the head's time while a notice is undelivered, and no problem when it has none", () => {
    const mailbox = mailboxOf(storedWith({}));

    expect(mailbox).toStrictEqual({
      tenantId: "default",
      pauseId: "pause-1",
      recipient: "listener:audit-listener",
      notices: [{ seq: 1, kind: PauseNoticeKind.Opened, writtenAt: WRITTEN }],
      delivered: 0,
      attempts: 2,
      nextAttemptAt: new Date(WRITTEN),
      headWrittenAt: WRITTEN,
      isDead: false,
    });
  });

  it("has no head's time when every notice is delivered", () => {
    expect(mailboxOf(storedWith({ delivered: 1 }))).not.toHaveProperty("headWrittenAt");
  });

  it("has the problem when there is one", () => {
    expect(mailboxOf(storedWith({ problem: "refused", is_dead: true }))).toMatchObject({
      problem: "refused",
      isDead: true,
    });
  });
});
