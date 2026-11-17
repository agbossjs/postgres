import { PauseStatus } from "@agboss/core";
import { minutes } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { LATER, NINE, instanceOn, pauseOf } from "./pause-fixtures.js";

/**
 * What a scan refuses, by name (agbossjs/agboss#935, #1213): the limit of every scan and the claim,
 * the filter, the cursor — a refused argument rejects the promise with a message that says what is
 * wrong — and the page's `next`, which is there exactly when more follow.
 */
const database = testDatabase();
const store = (): ReturnType<typeof instanceOn> => instanceOn(database.url());
const FILTER = { statuses: [PauseStatus.Pending] };

const limitMessage = (limit: number): string =>
  `a pause scan's limit is a whole number from 1 to 1000, not ${String(limit)}`;

const scansWith: readonly (readonly [string, (limit: number) => Promise<unknown>])[] = [
  ["findPendingByExpiresAtBefore", (limit) => store().findPendingByExpiresAtBefore(LATER, limit)],
  ["findPendingByRemindAtBefore", (limit) => store().findPendingByRemindAtBefore(LATER, limit)],
  ["findOpenAfter", (limit) => store().findOpenAfter(undefined, limit)],
  ["findPageByTenantId", (limit) => store().findPageByTenantId("default", FILTER, limit)],
  ["findClosedByResolvedAtBefore", (limit) => store().findClosedByResolvedAtBefore(LATER, limit)],
  [
    "findPendingUnsentReassignedBefore",
    (limit) => store().findPendingUnsentReassignedBefore(LATER, limit),
  ],
  ["claimNoticesDue", (limit) => store().claimNoticesDue(NINE, limit, minutes(1), ["any"])],
  [
    "setAsideStaleNoticesBefore",
    (limit) => store().setAsideStaleNoticesBefore(NINE, NINE, "x", limit),
  ],
];

describe("a scan's limit", () => {
  it.each(scansWith)(
    "%s rejects a limit that is not a whole number from 1 to 1000",
    async (_name, scan) => {
      for (const limit of [0, -1, 1001, 1.5, Number.NaN])
        await expect(scan(limit)).rejects.toThrow(new RangeError(limitMessage(limit)));
    },
  );

  it.each(scansWith)("%s accepts the bounds, 1 and 1000", async (_name, scan) => {
    await expect(scan(1)).resolves.toBeDefined();
    await expect(scan(1000)).resolves.toBeDefined();
  });
});

describe("a pause filter and a page cursor", () => {
  it("a filter without a status is refused by name", async () => {
    await expect(store().findPageByTenantId("default", { statuses: [] }, 5)).rejects.toThrow(
      new TypeError("a pause filter names at least one status"),
    );
  });

  it.each([
    "abc",
    "12a",
    "a12",
    "1e3",
    "-1",
    "1.5",
    " 12",
    "",
    "9007199254740992",
    "99999999999999999999",
  ])("the cursor %j is refused by name, by every scan that takes one", async (cursor) => {
    const message = new TypeError(`${JSON.stringify(cursor)} is not a pause page cursor`);
    await expect(store().findOpenAfter(cursor, 5)).rejects.toThrow(message);
    await expect(store().findPageByTenantId("default", FILTER, 5, cursor)).rejects.toThrow(message);
    await expect(store().findClosedByResolvedAtBefore(LATER, 5, cursor)).rejects.toThrow(message);
  });

  it.each(["0", "7", "9007199254740991"])(
    "the cursor %j is a position: the page is read",
    async (cursor) => {
      await expect(store().findOpenAfter(cursor, 5)).resolves.toEqual({ pauses: [] });
    },
  );
});

const idsOf = (pauses: readonly { pauseId: string }[]): string[] =>
  pauses.map((pause) => pause.pauseId);

describe("a page's next cursor", () => {
  it("is the sequence of the page's last pause, and there only when more follow", async () => {
    const pauses = store();
    await expect(pauses.findOpenAfter(undefined, 2)).resolves.toStrictEqual({ pauses: [] });
    for (const id of ["a", "b", "c", "d", "e"]) await pauses.findOrCreateByStepKey(pauseOf(id));
    const seqs = (await onSchema(database.url(), "SELECT pause_id, seq FROM agboss_pauses")).rows;
    const seqOf = (id: string): string => String(seqs.find((row) => row.pause_id === id)?.seq);

    const first = await pauses.findOpenAfter(undefined, 2);
    expect(idsOf(first.pauses)).toEqual(["a", "b"]);
    expect(first.next).toBe(seqOf("b"));
    const second = await pauses.findOpenAfter(first.next, 2);
    expect(idsOf(second.pauses)).toEqual(["c", "d"]);
    expect(second.next).toBe(seqOf("d"));
    const last = await pauses.findOpenAfter(second.next, 2);
    expect(idsOf(last.pauses)).toEqual(["e"]);
    expect(last).not.toHaveProperty("next");

    const exactly = await pauses.findOpenAfter(seqOf("c"), 2);
    expect(idsOf(exactly.pauses)).toEqual(["d", "e"]);
    expect(exactly).not.toHaveProperty("next");
    const tenants = await pauses.findPageByTenantId("default", FILTER, 4, seqOf("a"));
    expect(idsOf(tenants.pauses)).toEqual(["b", "c", "d", "e"]);
    expect(tenants).not.toHaveProperty("next");
    const more = await pauses.findPageByTenantId("default", FILTER, 3, seqOf("a"));
    expect(idsOf(more.pauses)).toEqual(["b", "c", "d"]);
    expect(more.next).toBe(seqOf("d"));
  });
});
