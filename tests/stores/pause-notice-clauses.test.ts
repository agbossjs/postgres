import { PauseResolution } from "@agboss/core";
import { PauseNoticeKind } from "@agboss/core/stores";
import { minutes } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { blockedBefore, openTransaction, pidOf } from "./pause-locks.js";
import { MID, NINE, RECIPIENTS, instanceOn, pauseOf } from "./pause-fixtures.js";

/**
 * Each clause of the mailboxes' statements a test proves (agbossjs/agboss#1302): dropping it from
 * the statement, one at a time, fails one of these.
 */
const database = testDatabase();
const store = (): ReturnType<typeof instanceOn> => instanceOn(database.url());
const AUDIT = "listener:audit-listener";
const LISTENER_ONLY = { listeners: ["audit-listener"] };
const NOON = new Date("2026-01-05T12:00:00.000Z");

/** Pauses `ids` of `tenantId`, each sent to the audit listener alone, its mailbox due at its ask. */
async function sent(ids: readonly string[], tenantId = "default"): Promise<void> {
  for (const id of ids) {
    await store().findOrCreateByStepKey({ ...pauseOf(id), tenantId });
    await store().markSentByTenantIdAndPauseId(tenantId, id, LISTENER_ONLY);
  }
}

describe("setting the stale aside", () => {
  it("passes over a mailbox another transaction holds, never waits for it", async () => {
    await sent(["held", "free"]);
    const holder = await openTransaction(database.url());
    await holder.query("SELECT 1 FROM agboss_pause_notices WHERE pause_id = 'held' FOR UPDATE");

    const setting = store().setAsideStaleNoticesBefore(NOON, NOON, "stale", 10);
    const isBlocked = await blockedBefore(database.url(), await pidOf(holder), setting);
    await holder.query("ROLLBACK");
    await holder.end();

    expect(isBlocked).toBe(false);
    expect((await setting).map((mailbox) => mailbox.pauseId)).toEqual(["free"]);
  });

  it("sets a mailbox aside once: a dead one keeps the problem it was set aside for", async () => {
    await sent(["dead-once"]);
    await store().setAsideStaleNoticesBefore(NOON, NOON, "first problem", 10);

    const again = await store().setAsideStaleNoticesBefore(NOON, NOON, "second problem", 10);

    expect(again.filter((mailbox) => mailbox.pauseId === "dead-once")).toEqual([]);
    const { rows } = await onSchema(
      database.url(),
      "SELECT problem FROM agboss_pause_notices WHERE pause_id = 'dead-once'",
    );
    expect(rows).toEqual([{ problem: "first problem" }]);
  });
});

describe("appending to a mailbox", () => {
  it("a mailbox whose notices were all delivered takes the new one as its head, due at once", async () => {
    await sent(["idle"]);
    const [claim] = (await store().claimNoticesDue(NOON, 10, minutes(5), [AUDIT])).filter(
      (one) => one.mailbox.pauseId === "idle",
    );
    if (claim === undefined) throw new Error("the mailbox was not claimed");
    await store().ackNotice(claim, NINE);

    await store().cancelByTenantIdAndPauseId(
      "default",
      "idle",
      PauseResolution.Cancelled,
      MID,
      LISTENER_ONLY,
    );

    const { rows } = await onSchema(
      database.url(),
      "SELECT head_written_at, next_attempt_at FROM agboss_pause_notices WHERE pause_id = 'idle'",
    );
    expect(rows).toEqual([{ head_written_at: MID, next_attempt_at: MID }]);
  });

  it("a notice of a kind written once is stopped by that kind of this pause only", async () => {
    await sent(["once-here", "once-other"]);
    await sent(["once-here"], "tenant-b");
    const once = (tenantId: string, pauseId: string): Promise<boolean> =>
      store().noticeOnceByTenantIdAndPauseId(
        tenantId,
        pauseId,
        PauseNoticeKind.JoinFailed,
        { errorCode: "E1" },
        NINE,
        RECIPIENTS,
      );
    expect(await once("default", "once-other")).toBe(true);

    // the same kind sits in another pause of the tenant, and in a pause of that name in another tenant
    expect(await once("default", "once-here")).toBe(true);
    expect(await once("tenant-b", "once-here")).toBe(true);
    expect(await once("default", "once-here")).toBe(false);
  });
});
