import { PauseResolution, PauseStatus } from "@agboss/core";
import { NO_RECIPIENTS } from "@agboss/core/stores";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { isWaitingOnLock } from "./pause-locks.js";
import { APPROVED, MID, RECIPIENTS, expiringPauseOf, instanceOn } from "./pause-fixtures.js";

/**
 * agbossjs/agboss#936 AC1 (I7): a notice and its change are one transaction. The contract suite sees
 * the store from outside and cannot tell a split commit from a whole one, so the database is made
 * to refuse or to hold the notice's insert — as a full disk or a dead connection would.
 */
const database = testDatabase();
const HOLD_KEY = 936_936;

const stateOf = async (pauseId: string): Promise<{ status: string; isSent: boolean }> => {
  const { rows } = await onSchema(
    database.url(),
    "SELECT record->>'status' AS status, (record->>'isSent')::boolean AS \"isSent\" FROM agboss_pauses WHERE pause_id = $1",
    [pauseId],
  );
  return { status: String(rows[0]?.status), isSent: rows[0]?.isSent === true };
};

const noticeCount = async (): Promise<number> => {
  const { rows } = await onSchema(
    database.url(),
    "SELECT count(*)::int AS n FROM agboss_pause_notices",
  );
  return Number(rows[0]?.n);
};

describe("a change and its notices are one transaction", () => {
  it("a notice that cannot be written leaves its change undone — every transition that writes one", async () => {
    const store = instanceOn(database.url());
    for (const id of ["p1", "p2", "p3", "p4", "p5"]) {
      await store.findOrCreateByStepKey(expiringPauseOf(id));
      if (id !== "p1") await store.markSentByTenantIdAndPauseId("default", id, NO_RECIPIENTS);
    }
    await onSchema(
      database.url(),
      `CREATE FUNCTION refuse_notice() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN RAISE EXCEPTION 'disk full'; END $$;
       CREATE TRIGGER no_notices BEFORE INSERT ON agboss_pause_notices
         FOR EACH ROW EXECUTE FUNCTION refuse_notice()`,
    );
    const late = new Date("2026-01-05T10:30:00.000Z");

    const refused = [
      store.markSentByTenantIdAndPauseId("default", "p1", RECIPIENTS),
      store.resolveByTenantIdAndPauseId("default", "p2", APPROVED, MID, RECIPIENTS),
      store.cancelByTenantIdAndPauseId("default", "p3", PauseResolution.Cancelled, MID, RECIPIENTS),
      store.expireByTenantIdAndPauseId("default", "p4", {}, late, RECIPIENTS),
      store.extendByTenantIdAndPauseId(
        "default",
        "p5",
        { expiresAt: "2026-01-05T12:00:00.000Z" },
        MID,
        RECIPIENTS,
      ),
    ];

    for (const attempt of refused) await expect(attempt).rejects.toThrow("disk full");
    expect(await stateOf("p1")).toEqual({ status: PauseStatus.Pending, isSent: false });
    for (const id of ["p2", "p3", "p4", "p5"])
      expect(await stateOf(id)).toEqual({ status: PauseStatus.Pending, isSent: true });
    expect((await store.findByTenantIdAndPauseId("default", "p5"))?.expiresAt).toBe(
      "2026-01-05T10:00:00.000Z",
    );
    expect(await noticeCount()).toBe(0);
    await onSchema(database.url(), "DROP TRIGGER no_notices ON agboss_pause_notices");
  });

  it("killed between the two writes — the change made, the notice held — the change is not there", async () => {
    await onSchema(database.url(), "DELETE FROM agboss_pauses");
    const store = instanceOn(database.url());
    await store.findOrCreateByStepKey(expiringPauseOf("held"));
    await store.markSentByTenantIdAndPauseId("default", "held", NO_RECIPIENTS);
    // the notice's insert waits for an advisory lock: the hold point between the two writes
    await onSchema(
      database.url(),
      `CREATE FUNCTION hold_notice() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN PERFORM pg_advisory_lock(${String(HOLD_KEY)});
           PERFORM pg_advisory_unlock(${String(HOLD_KEY)}); RETURN NEW; END $$;
       CREATE TRIGGER hold_notices BEFORE INSERT ON agboss_pause_notices
         FOR EACH ROW EXECUTE FUNCTION hold_notice()`,
    );
    const holder = new pg.Client({ connectionString: database.url() });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1)", [HOLD_KEY]);

    const resolving = store.resolveByTenantIdAndPauseId(
      "default",
      "held",
      APPROVED,
      MID,
      RECIPIENTS,
    );
    const outcome = resolving.then(
      () => "resolved",
      () => "killed",
    );
    while (!(await isWaitingOnLock(database.url()))) await Promise.resolve();
    const [midway] = [await stateOf("held")];
    await onSchema(
      database.url(),
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    );
    const result = await outcome;
    await holder.query("SELECT pg_advisory_unlock($1)", [HOLD_KEY]);
    await holder.end();

    expect(midway.status).toBe(PauseStatus.Pending);
    expect(result).toBe("killed");
    expect(await stateOf("held")).toEqual({ status: PauseStatus.Pending, isSent: true });
    expect(await noticeCount()).toBe(0);
    await onSchema(database.url(), "DROP TRIGGER hold_notices ON agboss_pause_notices");
    expect(
      await store.resolveByTenantIdAndPauseId("default", "held", APPROVED, MID, RECIPIENTS),
    ).toMatchObject({ status: PauseStatus.Resolved });
    expect(await noticeCount()).toBe(3);
  });
});
