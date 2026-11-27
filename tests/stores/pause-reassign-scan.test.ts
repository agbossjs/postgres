import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import {
  DEADLINE,
  LATER,
  NINE,
  RECIPIENTS,
  expiringPauseOf,
  instanceOn,
  seenNowOf,
} from "./pause-fixtures.js";

/**
 * A reassignment's replacement (agbossjs/agboss#946, #1213): its deadline and reminder are the
 * columns the scans read, and the scan of the unsent replacements keeps its place by
 * `(askedAt, tenant, pause)` through replacements asked at one instant.
 */
const database = testDatabase();
const store = (): ReturnType<typeof instanceOn> => instanceOn(database.url());

describe("the replacement of a reassigned pause", () => {
  it("has the deadline and the reminder of the pause in its columns", async () => {
    await store().findOrCreateByStepKey(expiringPauseOf("old"));

    const made = await store().reassignByTenantIdAndPauseId(
      "default",
      "old",
      { pauseId: "new", assignees: ["bob"], seen: await seenNowOf(store(), "default", "old") },
      NINE,
      RECIPIENTS,
    );

    expect(made).toMatchObject({ pauseId: "new", remindAt: new Date("2026-01-05T09:30:00.000Z") });
    const { rows } = await onSchema(
      database.url(),
      "SELECT expires_at, remind_at FROM agboss_pauses WHERE pause_id = 'new'",
    );
    expect(rows).toEqual([
      { expires_at: DEADLINE, remind_at: new Date("2026-01-05T09:30:00.000Z") },
    ]);
    expect(
      (await store().findPendingByRemindAtBefore(LATER, 10)).map((one) => one.pauseId),
    ).toEqual(["new"]);
  });
});

describe("the unsent replacements scan", () => {
  it("goes on past the last pause of a page through replacements asked at one instant", async () => {
    const ids = ["r1", "r2", "r3", "r4"];
    for (const id of ids) {
      await store().findOrCreateByStepKey({
        ...expiringPauseOf(`from-${id}`),
        expiresAt: undefined,
      });
      await store().reassignByTenantIdAndPauseId(
        "default",
        `from-${id}`,
        {
          pauseId: id,
          assignees: ["bob"],
          seen: await seenNowOf(store(), "default", `from-${id}`),
        },
        NINE,
        RECIPIENTS,
      );
    }
    const seen: string[] = [];
    let after: { at: Date; tenantId: string; pauseId: string } | undefined;

    for (;;) {
      const [page] = await store().findPendingUnsentReassignedBefore(LATER, 1, after);
      if (page === undefined) break;
      seen.push(page.pauseId);
      after = { at: page.askedAt, tenantId: page.tenantId, pauseId: page.pauseId };
    }

    expect(seen).toEqual(["new", ...ids]);
    const together = await store().findPendingUnsentReassignedBefore(LATER, 10, {
      at: NINE,
      tenantId: "default",
      pauseId: "r2",
    });
    expect(together.map((one) => one.pauseId)).toEqual(["r3", "r4"]);
  });
});
