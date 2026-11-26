import { PauseResolution } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "@agboss/core/testing";
import { PostgresPausedExecutionRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";
import { blockedBefore, openTransaction, pidOf } from "./pause-locks.js";
import {
  APPROVED,
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
 * Each clause of the pauses' statements a test proves (agbossjs/agboss#1302): dropping it from the
 * statement, one at a time, fails one of these.
 */
const database = testDatabase();
const store = (): ReturnType<typeof instanceOn> => instanceOn(database.url());
const LISTENER_ONLY = { listeners: ["audit-listener"] };

const empty = async (): Promise<void> => {
  await onSchema(database.url(), "DELETE FROM agboss_pause_notices");
  await onSchema(database.url(), "DELETE FROM agboss_pauses");
};

const idsOfPauses = async (): Promise<string[]> =>
  (
    await onSchema(
      database.url(),
      "SELECT tenant_id || '/' || pause_id AS id FROM agboss_pauses ORDER BY 1",
    )
  ).rows.map((row: { id: string }) => row.id);

/** A pause cancelled at `at` (nine): closed, its mailboxes none. */
async function closed(id: string, tenantId = "default", at = NINE): Promise<void> {
  await store().findOrCreateByStepKey({ ...pauseOf(id), tenantId });
  await store().cancelByTenantIdAndPauseId(
    tenantId,
    id,
    PauseResolution.Cancelled,
    at,
    LISTENER_ONLY,
  );
}

const mailboxesStored = async (): Promise<string[]> =>
  (
    await onSchema(
      database.url(),
      "SELECT tenant_id || '/' || pause_id AS id FROM agboss_pause_notices ORDER BY 1",
    )
  ).rows.map((row: { id: string }) => row.id);

describe("the retention's removal of closed pauses", () => {
  it("waits for a transaction that holds a candidate, then reads its mailboxes: a notice just written keeps the pause", async () => {
    await empty();
    await closed("victim");
    const writer = await openTransaction(database.url());
    await writer.query("SELECT 1 FROM agboss_pauses WHERE pause_id = 'victim' FOR UPDATE");
    await writer.query(
      `INSERT INTO agboss_pause_notices (tenant_id, pause_id, recipient, notices, delivered,
         attempts, next_attempt_at, head_written_at, is_dead)
       VALUES ('default', 'victim', 'listener:audit-listener',
         '[{"seq":0,"kind":"opened","writtenAt":"2026-01-05T09:00:00.000Z"}]', 0, 0, now(), now(), false)`,
    );

    const removing = store().deleteByResolvedAtBefore(LATER);
    const isBlocked = await blockedBefore(database.url(), await pidOf(writer), removing);
    await writer.query("COMMIT");
    await writer.end();
    await removing;

    expect(isBlocked).toBe(true);
    expect(await idsOfPauses()).toEqual(["default/victim"]);
  });

  it("locks the pauses it may remove only: one resolved and not yet taken is not waited for", async () => {
    await empty();
    await store().findOrCreateByStepKey(pauseOf("resolved"));
    await store().resolveByTenantIdAndPauseId("default", "resolved", APPROVED, MID, RECIPIENTS);
    const holder = await openTransaction(database.url());
    await holder.query("SELECT 1 FROM agboss_pauses WHERE pause_id = 'resolved' FOR UPDATE");

    const removing = store().deleteByResolvedAtBefore(LATER);
    const isBlocked = await blockedBefore(database.url(), await pidOf(holder), removing);
    await holder.query("ROLLBACK");
    await holder.end();
    await removing;

    expect(isBlocked).toBe(false);
    expect(await idsOfPauses()).toEqual(["default/resolved"]);
  });

  it("keeps a pause for its own live mailbox only: another pause's or another tenant's does not", async () => {
    await empty();
    await closed("victim");
    await closed("victim", "tenant-b");
    await closed("busy");
    // a live mailbox: the open pause of tenant-b and `busy` were told of their cancellation
    await store().findOrCreateByStepKey({ ...pauseOf("victim"), tenantId: "tenant-b" });
    await store().markSentByTenantIdAndPauseId("tenant-b", "victim", LISTENER_ONLY);
    await store().markSentByTenantIdAndPauseId("default", "busy", LISTENER_ONLY);
    await onSchema(
      database.url(),
      "DELETE FROM agboss_pause_notices WHERE pause_id = 'victim' AND tenant_id = 'default'",
    );

    await store().deleteByResolvedAtBefore(LATER);

    expect(await idsOfPauses()).toEqual(["default/busy", "tenant-b/victim"]);
    // and only the mailboxes of the pauses it removed
    expect(await mailboxesStored()).toEqual(["default/busy", "tenant-b/victim"]);
  });

  it("locks the pauses resolved before its cutoff only: a recent one is not waited for", async () => {
    await empty();
    await closed("old");
    await closed("recent", "default", MID);
    const holder = await openTransaction(database.url());
    await holder.query("SELECT 1 FROM agboss_pauses WHERE pause_id = 'recent' FOR UPDATE");

    const removing = store().deleteByResolvedAtBefore(new Date("2026-01-05T09:30:00.000Z"));
    const isBlocked = await blockedBefore(database.url(), await pidOf(holder), removing);
    await holder.query("ROLLBACK");
    await holder.end();
    await removing;

    expect(isBlocked).toBe(false);
    expect(await idsOfPauses()).toEqual(["default/recent"]);
  });

  it("removes the pauses it locked only: one closed after the lock is left to the next run", async () => {
    await empty();
    await closed("locked");
    await store().findOrCreateByStepKey(pauseOf("late"));
    const connection = connectionTo(database.url());
    const retention = new PostgresPausedExecutionRepository(connection, new VirtualClock());
    const connect = connection.pool.connect.bind(connection.pool);
    // the pause closes between the retention's lock and its removal
    Reflect.defineProperty(connection.pool, "connect", {
      configurable: true,
      value: async () => {
        const client = await connect();
        const query = Reflect.get(client, "query") as (...args: unknown[]) => Promise<unknown>;
        Reflect.defineProperty(client, "query", {
          configurable: true,
          value: async (...args: unknown[]): Promise<unknown> => {
            const answer = await Reflect.apply(query, client, args);
            if (String(args[0]).includes("FOR UPDATE OF"))
              await store().cancelByTenantIdAndPauseId(
                "default",
                "late",
                PauseResolution.Cancelled,
                NINE,
                LISTENER_ONLY,
              );
            return answer;
          },
        });
        return client;
      },
    });

    await retention.deleteByResolvedAtBefore(LATER);

    expect(await idsOfPauses()).toEqual(["default/late"]);
  });

  it("keeps a reassigned pause for its replacement of its own tenant only", async () => {
    await empty();
    await store().findOrCreateByStepKey(expiringPauseOf("old"));
    await store().reassignByTenantIdAndPauseId(
      "default",
      "old",
      { pauseId: "new", assignees: ["bob"], seen: await seenNowOf(store(), "default", "old") },
      NINE,
      RECIPIENTS,
    );
    // the replacement is gone from its tenant; a pause of that name lives in another one
    await onSchema(database.url(), "DELETE FROM agboss_pauses WHERE pause_id = 'new'");
    await store().findOrCreateByStepKey({ ...pauseOf("new"), tenantId: "tenant-b" });

    await store().deleteByResolvedAtBefore(LATER);

    expect(await idsOfPauses()).toEqual(["tenant-b/new"]);
  });
});
