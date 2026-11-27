import { PauseResolution } from "@agboss/core";
import {
  PauseNoticeKind,
  PauseStatus,
  seenOf,
  StoreError,
  type PauseNoticeClaim,
  type PauseReplacement,
} from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresConnection, PostgresPausedExecutionRepository } from "../../src/index.js";
import { PauseChanges } from "../../src/stores/paused/pause-changes.js";
import {
  ackHead,
  renewHead,
  retryHead,
  setAsideStale,
} from "../../src/stores/paused/pause-delivery-rows.js";
import { reassigned } from "../../src/stores/paused/pause-reassign.js";
import { PauseScans } from "../../src/stores/paused/pause-scans.js";
import { PauseTimerChanges } from "../../src/stores/paused/pause-timer-changes.js";
import { pausedRunOfJson } from "../../src/stores/framework-json.js";
import { APPROVED, MID, NINE, RECIPIENTS, expiringPauseOf } from "./pause-fixtures.js";
import { recordedPool } from "./recorded-pool.js";
import { pausedRun } from "./stored-rows.fixtures.js";

/**
 * The refusals of an Invalid Date and the loud failure of a write that missed its locked row
 * (agbossjs/agboss#1307, P6b): every entry point that binds a time refuses a bad one with
 * `StoreError.UnreadableRecord` before any statement writes, and a compare-and-set that misses under
 * the row lock is damage — a thrown invariant that rolls the transaction back, as in the core's
 * SQLite store — never a lost race. And what node-postgres makes of every bound value.
 */
const INVALID = new Date(Number.NaN);
const pause = expiringPauseOf("p");
const rowOf = { record: JSON.parse(JSON.stringify(pause)) as unknown };
const CLAIM: PauseNoticeClaim = {
  token: "t",
  until: MID,
  mailbox: {
    tenantId: "default",
    pauseId: "p",
    recipient: "listener:a",
    notices: [],
    delivered: 0,
    attempts: 0,
    nextAttemptAt: MID,
    isDead: false,
  },
};
const change: PauseReplacement = { pauseId: "q", seen: seenOf(pause) };

const refused = async (attempt: () => Promise<unknown>): Promise<void> => {
  await expect(attempt()).rejects.toBeInstanceOf(StoreError.UnreadableRecord);
};

describe("an Invalid Date is refused before any write", () => {
  it("by the closers and the reassignment that were not covered", async () => {
    const changes = (): PauseChanges => new PauseChanges(recordedPool([[rowOf]]).pool);
    await refused(() => changes().decide("default", "p", APPROVED, INVALID, seenOf(pause)));
    await refused(() =>
      changes().closeUntaken("default", "p", PauseResolution.Cancelled, INVALID, RECIPIENTS),
    );
    await refused(() =>
      reassigned(
        recordedPool([[rowOf]]).pool,
        { tenantId: "default", pauseId: "p" },
        change,
        INVALID,
        RECIPIENTS,
      ),
    );
    await refused(() =>
      reassigned(
        recordedPool([[rowOf]]).pool,
        { tenantId: "default", pauseId: "p" },
        { ...change, due: { expiresAt: INVALID } },
        MID,
        RECIPIENTS,
      ),
    );
  });

  it("by every mailbox statement, with nothing sent", async () => {
    const { pool, sent } = recordedPool();

    await refused(() => ackHead(pool, CLAIM, INVALID));
    await refused(() => renewHead(pool, CLAIM, INVALID, 1000));
    await refused(() => renewHead(pool, CLAIM, MID, Number.NaN));
    await refused(() => retryHead(pool, CLAIM, INVALID, "later"));
    await refused(() => setAsideStale(pool, INVALID, MID, "stale", 5));
    await refused(() => setAsideStale(pool, MID, INVALID, "stale", 5));

    expect(sent).toHaveLength(0);
  });

  it("by the listing's filter, the retention's page and a notice's own times", async () => {
    const { pool, sent } = recordedPool();

    await refused(() =>
      new PauseScans(pool).ofAllTenants(
        { statuses: [PauseStatus.Pending], expiresBefore: INVALID },
        "0",
        5,
      ),
    );
    await refused(() =>
      new PauseScans(pool).ofTenant(
        "default",
        { statuses: [PauseStatus.Pending], expiresBefore: INVALID },
        "0",
        5,
      ),
    );
    await refused(() => new PauseScans(pool).closedBefore(INVALID, "0", 5));
    await refused(() =>
      new PauseTimerChanges(recordedPool([[rowOf]]).pool).noticeOnce(
        "default",
        "p",
        PauseNoticeKind.Expiring,
        { expiresAt: INVALID },
        MID,
        RECIPIENTS,
      ),
    );
    expect(sent).toHaveLength(0);
  });

  it("by the paused run's save, on the deadline of a pending pause", async () => {
    const run = pausedRunOfJson(JSON.stringify(pausedRun));
    const bad = { ...run, pending: run.pending.map((one) => ({ ...one, expiresAt: INVALID })) };
    const connection = new PostgresConnection({ url: "postgres://u:p@localhost:1/d" });
    try {
      const store = new PostgresPausedExecutionRepository(connection, new VirtualClock());

      await refused(() => store.save({ run: bad, workflowVersion: "1", configHash: "h" }));
    } finally {
      await connection.onDestroy();
    }
  });
});

describe("a write that missed its row under the lock", () => {
  it("throws and rolls back, never answers 'did not apply'", async () => {
    const { pool, sent } = recordedPool([[rowOf], []]);

    await expect(
      new PauseChanges(pool).resolve("default", "p", APPROVED, MID, RECIPIENTS, seenOf(pause)),
    ).rejects.toThrow(/unreachable: 0 rows changed/);

    expect(sent.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("markSent's update is checked the same way", async () => {
    const { pool, sent } = recordedPool([[rowOf], []]);

    await expect(new PauseTimerChanges(pool).markSent("default", "p", RECIPIENTS)).rejects.toThrow(
      /unreachable: 0 rows changed/,
    );

    expect(sent.at(-1)?.sql).toBe("ROLLBACK");
  });
});

/** node-postgres's own conversion of a bound value: where a `Date` becomes local time with an offset. */
const utils = createRequire(import.meta.url)("pg/lib/utils") as {
  prepareValue: (value: unknown) => unknown;
};
const { prepareValue } = utils;
const ZONE = process.env.TZ;
afterEach(() => {
  if (ZONE === undefined) delete process.env.TZ;
  else process.env.TZ = ZONE;
});

describe("what node-postgres sends of a bound time", () => {
  for (const zone of ["UTC", "Asia/Jerusalem", "America/New_York"])
    it(`${zone}: a text parameter is its ISO text as it is, a timestamptz parameter names the instant`, async () => {
      process.env.TZ = zone;
      const { pool, sent } = recordedPool();
      const cutoff = new Date("2026-03-29T00:30:00.123Z");

      await new PauseScans(pool).reassignedUnsentBefore(cutoff, 5, {
        at: NINE,
        tenantId: "default",
        pauseId: "r",
      });

      const [text, , keyset] = sent[0]?.values ?? [];
      expect(prepareValue(text)).toBe("2026-03-29T00:30:00.123Z");
      expect(prepareValue(keyset)).toBe("2026-01-05T09:00:00.000Z");
      // a Date for a timestamptz: the offset is in the text, so the instant is the same in any zone
      expect(new Date(String(prepareValue(cutoff))).getTime()).toBe(cutoff.getTime());
    });
});
