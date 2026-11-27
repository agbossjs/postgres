import { PauseResolution, PauseStatus, type PauseRecord } from "@agboss/core";
import {
  PauseNoticeKind,
  reassignChange,
  resolveChange,
  seenOf,
  StoreError,
  StoreErrorKind,
  type PauseReplacement,
} from "@agboss/core/stores";
import { afterEach, describe, expect, it } from "vitest";
import { PauseChanges } from "../../src/stores/paused/pause-changes.js";
import { reassigned } from "../../src/stores/paused/pause-reassign.js";
import { PauseRows } from "../../src/stores/paused/pause-rows.js";
import { PauseScans } from "../../src/stores/paused/pause-scans.js";
import { PauseTimerChanges } from "../../src/stores/paused/pause-timer-changes.js";
import { APPROVED, DEADLINE, MID, NINE, RECIPIENTS, expiringPauseOf } from "./pause-fixtures.js";
import { recordedPool, squeezed } from "./recorded-pool.js";

/**
 * The times of a pause as the statements carry them (agbossjs/agboss#1307, P6b): the core's pure
 * transitions plan, the store writes — `Date`s as `timestamptz` parameters, the record as the
 * `toISOString()` text of its JSON, the TEXT compares of the unsent scan as `toISOString()` texts —
 * under any process time zone, an Invalid Date refused before the first write, what is handed back
 * read from the database and so never the caller's own `Date`. What the database answers is the
 * contract suite's.
 */
const ZONE = process.env.TZ;
const ZONES = ["UTC", "Asia/Jerusalem", "America/New_York"];

afterEach(() => {
  if (ZONE === undefined) delete process.env.TZ;
  else process.env.TZ = ZONE;
});

/** A row as the database gives it: the record's JSON, its times texts. */
const rowOf = (pause: PauseRecord): { record: unknown } => ({
  record: JSON.parse(JSON.stringify(pause)) as unknown,
});

const pause = expiringPauseOf("p");
const writes = (sent: readonly { sql: string }[]): number =>
  sent.filter(({ sql }) => /^\s*(UPDATE|INSERT)/u.test(sql)).length;

describe("what a change writes of a time", () => {
  for (const zone of ZONES)
    it(`${zone}: the columns are Dates, the record's JSON holds ISO texts`, async () => {
      process.env.TZ = zone;
      const at = new Date("2026-01-05T09:45:00.123Z");
      const planned = resolveChange(pause, APPROVED, at, RECIPIENTS, seenOf(pause));
      const { pool, sent } = recordedPool([[rowOf(pause)], [rowOf(planned?.pause ?? pause)]]);

      await new PauseChanges(pool).resolve("default", "p", APPROVED, at, RECIPIENTS, seenOf(pause));

      const write = sent.find(({ sql }) => sql.startsWith("UPDATE agboss_pauses"));
      expect(write?.values.slice(0, 4)).toEqual([
        "default",
        "p",
        PauseStatus.Pending,
        PauseStatus.Resolved,
      ]);
      expect(write?.values[4]).toEqual(at);
      expect(write?.values[5]).toEqual(DEADLINE);
      expect(write?.values[6]).toEqual(new Date("2026-01-05T09:30:00.000Z"));
      const text = String(write?.values[7]);
      expect(JSON.parse(text)).toMatchObject({
        resolvedAt: "2026-01-05T09:45:00.123Z",
        expiresAt: "2026-01-05T10:00:00.000Z",
      });
      expect(text).not.toMatch(/GMT|[+-]\d\d:\d\d"/u);
    });

  it("hands back the record as stored: no Date of the caller's, none shared between calls", async () => {
    const at = new Date("2026-01-05T09:45:00.000Z");
    const planned = resolveChange(pause, APPROVED, at, RECIPIENTS, seenOf(pause));
    const answers = [[rowOf(pause)], [rowOf(planned?.pause ?? pause)]];
    const first = await new PauseChanges(recordedPool(answers).pool).resolve(
      "default",
      "p",
      APPROVED,
      at,
      RECIPIENTS,
      seenOf(pause),
    );

    expect(first?.resolvedAt).toEqual(at);
    expect(first?.resolvedAt).not.toBe(at);
    first?.resolvedAt?.setTime(0);
    first?.expiresAt?.setTime(0);
    expect(at.getTime()).toBe(Date.parse("2026-01-05T09:45:00.000Z"));
    expect(DEADLINE.getTime()).toBe(Date.parse("2026-01-05T10:00:00.000Z"));
  });

  it("a pause that is none, or a transition that does not apply, writes nothing", async () => {
    const none = recordedPool([[]]);
    expect(
      await new PauseChanges(none.pool).cancel(
        "default",
        "p",
        PauseResolution.Cancelled,
        MID,
        RECIPIENTS,
      ),
    ).toBeUndefined();
    const late = recordedPool([[rowOf(pause)]]);
    const after = new Date("2026-01-05T10:00:00.000Z"); // the deadline: no answer at it
    expect(
      await new PauseChanges(late.pool).resolve(
        "default",
        "p",
        APPROVED,
        after,
        RECIPIENTS,
        seenOf(pause),
      ),
    ).toBeUndefined();
    expect(writes(none.sent) + writes(late.sent)).toBe(0);
  });

  it("an Invalid Date is a StoreError.UnreadableRecord before any write, whatever the change", async () => {
    const invalid = new Date(Number.NaN);
    const attempts: (() => Promise<unknown>)[] = [
      () =>
        new PauseChanges(recordedPool([[rowOf(pause)]]).pool).resolve(
          "default",
          "p",
          APPROVED,
          invalid,
          RECIPIENTS,
        ),
      () =>
        new PauseChanges(recordedPool([[rowOf(pause)]]).pool).expire(
          "default",
          "p",
          {},
          invalid,
          RECIPIENTS,
        ),
      () =>
        new PauseChanges(recordedPool([[rowOf(pause)]]).pool).cancel(
          "default",
          "p",
          PauseResolution.Cancelled,
          invalid,
          RECIPIENTS,
        ),
      () =>
        new PauseTimerChanges(recordedPool([[rowOf(pause)]]).pool).remind(
          "default",
          "p",
          invalid,
          RECIPIENTS,
        ),
      () =>
        new PauseTimerChanges(recordedPool([[rowOf(pause)]]).pool).changeTimeout(
          "default",
          "p",
          { expiresAt: invalid, previousExpiresAt: DEADLINE, seen: seenOf(pause) },
          MID,
          RECIPIENTS,
        ),
      () =>
        new PauseTimerChanges(recordedPool([[rowOf(pause)]]).pool).noticeOnce(
          "default",
          "p",
          PauseNoticeKind.Expiring,
          {},
          invalid,
          RECIPIENTS,
        ),
      () => new PauseRows(recordedPool().pool).findOrCreate({ ...pause, expiresAt: invalid }),
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(StoreError.UnreadableRecord);
      expect((error as StoreError.UnreadableRecord).kind).toBe(StoreErrorKind.UnreadableRecord);
    }
  });

  it("a refused time leaves the statements at the lock's read", async () => {
    const { pool, sent } = recordedPool([[rowOf(pause)]]);

    await expect(
      new PauseChanges(pool).resolve("default", "p", APPROVED, new Date(Number.NaN), RECIPIENTS),
    ).rejects.toBeInstanceOf(StoreError.UnreadableRecord);

    expect(writes(sent)).toBe(0);
    expect(squeezed(sent[1]?.sql ?? "")).toContain("FOR UPDATE");
    expect(sent.at(-1)?.sql).toBe("ROLLBACK");
  });
});

describe("a reassignment's replacement", () => {
  const change: PauseReplacement = { pauseId: "q", seen: seenOf(pause), assignees: ["ann"] };

  it("is inserted with its Dates as columns after the old pause closed, and handed back as stored", async () => {
    const planned = reassignChange(pause, change, new Set(), MID, RECIPIENTS);
    if (planned?.inserted === undefined) throw new Error("the fixture's reassignment must apply");
    const { pool, sent } = recordedPool([
      [rowOf(pause)],
      [],
      [rowOf(planned.pause)],
      [rowOf(planned.inserted)],
    ]);

    const made = await reassigned(
      pool,
      { tenantId: "default", pauseId: "p" },
      change,
      MID,
      RECIPIENTS,
    );

    const insert = sent.find(({ sql }) => sql.includes("INSERT INTO agboss_pauses"));
    expect(insert?.values[1]).toBe("q");
    expect(insert?.values[4]).toEqual(planned.inserted.expiresAt);
    expect(made?.pauseId).toBe("q");
    const closing = sent.find(({ sql }) => sql.startsWith("UPDATE agboss_pauses"));
    expect(closing?.values[3]).toBe(PauseStatus.Cancelled);
    expect(closing?.values[4]).toEqual(MID);
  });
});

describe("the unsent replacements' scan keeps its compare on TEXT", () => {
  for (const zone of ZONES)
    it(`${zone}: cutoff and keyset time bound as toISOString() texts, never Dates`, async () => {
      process.env.TZ = zone;
      const { pool, sent } = recordedPool();
      const cutoff = new Date("2026-03-29T00:30:00.123Z");
      const after = { at: NINE, tenantId: "default", pauseId: "r2" };

      await new PauseScans(pool).reassignedUnsentBefore(cutoff, 5, after);
      await new PauseScans(pool).reassignedUnsentBefore(cutoff, 5);

      expect(sent[0]?.values).toEqual([
        "2026-03-29T00:30:00.123Z",
        5,
        "2026-01-05T09:00:00.000Z",
        "default",
        "r2",
      ]);
      expect(sent[1]?.values).toEqual(["2026-03-29T00:30:00.123Z", 5, null, null, null]);
    });

  it("the deadline scans bind the Date as it is, for the timestamptz compare, and refuse an Invalid one", async () => {
    const { pool, sent } = recordedPool();
    const after = { at: NINE, tenantId: "default", pauseId: "r2" };

    await new PauseScans(pool).pendingDue("expires_at", MID, 5, after);

    expect(sent[0]?.values).toEqual([MID, 5, NINE, "default", "r2"]);
    await expect(
      new PauseScans(pool).pendingDue("expires_at", new Date(Number.NaN), 5),
    ).rejects.toBeInstanceOf(StoreError.UnreadableRecord);
    await expect(
      new PauseScans(pool).reassignedUnsentBefore(MID, 5, { ...after, at: new Date(Number.NaN) }),
    ).rejects.toBeInstanceOf(StoreError.UnreadableRecord);
    await expect(
      new PauseScans(pool).deleteClosedBefore(new Date(Number.NaN)),
    ).rejects.toBeInstanceOf(StoreError.UnreadableRecord);
  });
});
