import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { PostgresPausedExecutionRepository } from "../../src/index.js";
import { connectionTo } from "../support/stores.js";
import { onSchema, testDatabase } from "../support/database.js";
import { blockedBefore, openTransaction, pidOf } from "./pause-locks.js";
import {
  APPROVED,
  MID,
  NINE,
  RECIPIENTS,
  expiringPauseOf,
  instanceOn,
  pauseOf,
} from "./pause-fixtures.js";
import { pausedRun } from "./stored-rows.fixtures.js";

/**
 * Each clause of the pause row's statements a test proves (agbossjs/agboss#1302): dropping it from
 * the statement, one at a time, fails one of these.
 */
const database = testDatabase();
const store = (): ReturnType<typeof instanceOn> => instanceOn(database.url());

const noticeCount = async (pauseId: string): Promise<number> =>
  Number(
    (
      await onSchema(
        database.url(),
        "SELECT count(*)::int AS n FROM agboss_pause_notices WHERE pause_id = $1",
        [pauseId],
      )
    ).rows[0]?.n,
  );

describe("a pause's row", () => {
  it("is read under its lock: a markSent waits for the writer of the flag, then finds it set and writes nothing", async () => {
    await store().findOrCreateByStepKey(pauseOf("locked"));
    const writer = await openTransaction(database.url());
    await writer.query(
      "UPDATE agboss_pauses SET record = jsonb_set(record, '{isSent}', 'true') WHERE pause_id = 'locked'",
    );

    const marking = store().markSentByTenantIdAndPauseId("default", "locked", RECIPIENTS);
    const isBlocked = await blockedBefore(database.url(), await pidOf(writer), marking);
    await writer.query("COMMIT");
    await writer.end();

    expect(isBlocked).toBe(true);
    expect(await marking).toBe(true);
    expect(await noticeCount("locked")).toBe(0);
  });

  it("of a step is the one unique key the insert ignores: a pause id taken by another step is an error", async () => {
    await store().findOrCreateByStepKey(pauseOf("same-id", "run-1:step-a"));

    await expect(
      store().findOrCreateByStepKey(pauseOf("same-id", "run-1:step-b")),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("is reminded only while it is pending: a resolved pause's reminder is none", async () => {
    await store().findOrCreateByStepKey(expiringPauseOf("reminded"));
    await store().resolveByTenantIdAndPauseId("default", "reminded", APPROVED, NINE, RECIPIENTS);

    expect(await store().remindByTenantIdAndPauseId("default", "reminded", MID, RECIPIENTS)).toBe(
      false,
    );
  });
});

describe("a paused run's row", () => {
  it("saved again takes the new run id, workflow version, config hash and time with the new run", async () => {
    const clock = new VirtualClock();
    const pauses = new PostgresPausedExecutionRepository(connectionTo(database.url()), clock);
    await onSchema(
      database.url(),
      `INSERT INTO agboss_paused_executions VALUES ('acme', 'thread-1', 'run-1', $1, '1.0.0', 'hash-1', now())`,
      [JSON.stringify({ ...pausedRun, tenantId: "acme", threadId: "thread-1", runId: "run-1" })],
    );
    const found = await pauses.findByTenantIdAndThreadId("acme", "thread-1");
    if (found === undefined) throw new Error("the run was not stored");

    await pauses.save({
      run: { ...found.run, runId: "run-2" },
      workflowVersion: "2.0.0",
      configHash: "hash-2",
    });

    const { rows } = await onSchema(
      database.url(),
      "SELECT run_id, workflow_version, config_hash, paused_at FROM agboss_paused_executions WHERE thread_id = 'thread-1'",
    );
    expect(rows).toEqual([
      {
        run_id: "run-2",
        workflow_version: "2.0.0",
        config_hash: "hash-2",
        paused_at: clock.now(),
      },
    ]);
  });
});
