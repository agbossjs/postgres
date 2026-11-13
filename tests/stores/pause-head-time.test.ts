import { minutes } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { MID, RECIPIENTS, expiringPauseOf, instanceOn } from "./pause-fixtures.js";

/**
 * agbossjs/agboss#936 AC1 (#935 rule 1, V3.1): the head time of a mailbox — `head_written_at`, what
 * the retention's look reads — is the `writtenAt` of the first undelivered notice. An ack moves it to
 * the next notice's; the last ack leaves none.
 */
const database = testDatabase();
const NOON = new Date("2026-01-05T12:00:00.000Z");
const LISTENER = "listener:audit-listener";

const headOf = async (): Promise<Date | null> => {
  const { rows } = await onSchema(
    database.url(),
    "SELECT head_written_at FROM agboss_pause_notices WHERE recipient = $1",
    [LISTENER],
  );
  const head: unknown = rows[0]?.head_written_at;
  return head instanceof Date ? head : null;
};

describe("the head time of a mailbox", () => {
  it("an ack moves it to the next notice's writtenAt: the retention does not take a mailbox that moved on", async () => {
    const store = instanceOn(database.url());
    await store.findOrCreateByStepKey(expiringPauseOf("p"));
    await store.markSentByTenantIdAndPauseId("default", "p", RECIPIENTS);
    await store.extendByTenantIdAndPauseId(
      "default",
      "p",
      { expiresAt: "2026-01-05T11:00:00.000Z" },
      MID,
      RECIPIENTS,
    );
    // the listener's mailbox: opened (written 09:00), extended (written 09:45)
    expect(await headOf()).toEqual(new Date("2026-01-05T09:00:00.000Z"));
    const [claim] = await store.claimNoticesDue(MID, 10, minutes(5), [LISTENER]);
    if (claim === undefined) throw new Error("the listener's mailbox is due");

    const next = await store.ackNotice(claim, MID);

    expect(next?.mailbox.headWrittenAt).toBe(MID.toISOString());
    expect(await headOf()).toEqual(MID);
    const between = new Date("2026-01-05T09:30:00.000Z");
    expect(await store.setAsideStaleNoticesBefore(between, NOON, "stale", 10)).toEqual([
      { tenantId: "default", pauseId: "p", recipient: "listener:slack-listener" },
    ]);
    if (next === undefined) throw new Error("a notice remains");
    expect(await store.ackNotice(next, MID)).toBeUndefined();
    expect(await headOf()).toBeNull();
  });
  it("an append behind an undelivered head changes neither the head time nor the backoff", async () => {
    await onSchema(database.url(), "DELETE FROM agboss_pause_notices");
    await onSchema(database.url(), "DELETE FROM agboss_pauses");
    const store = instanceOn(database.url());
    await store.findOrCreateByStepKey(expiringPauseOf("q"));
    await store.markSentByTenantIdAndPauseId("default", "q", RECIPIENTS);
    const [claim] = await store.claimNoticesDue(MID, 10, minutes(5), [LISTENER]);
    if (claim === undefined) throw new Error("the listener's mailbox is due");
    await store.retryNotice(claim, NOON, "unreachable");

    await store.extendByTenantIdAndPauseId(
      "default",
      "q",
      { expiresAt: "2026-01-05T11:00:00.000Z" },
      MID,
      RECIPIENTS,
    );

    expect(await headOf()).toEqual(new Date("2026-01-05T09:00:00.000Z"));
    const { rows } = await onSchema(
      database.url(),
      "SELECT attempts, next_attempt_at, problem FROM agboss_pause_notices WHERE recipient = $1",
      [LISTENER],
    );
    expect(rows).toEqual([{ attempts: 1, next_attempt_at: NOON, problem: "unreachable" }]);
  });
});
