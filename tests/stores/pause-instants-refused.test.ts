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
import { transitioned } from "../../src/stores/paused/pause-transition.js";
import { pausedRunOfJson } from "../../src/stores/framework-json.js";
import { APPROVED, MID, NINE, RECIPIENTS, expiringPauseOf } from "./pause-fixtures.js";
import { recordedPool, type Sent } from "./recorded-pool.js";
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

/** The statements that write (UPDATE, INSERT). */
const writes = (sent: readonly Sent[]): number =>
  sent.filter(({ sql }) => /^\s*(UPDATE|INSERT)/u.test(sql)).length;

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

/** The message of the refusal an attempt gets: what it names. */
const messageOf = async (attempt: () => Promise<unknown>): Promise<string> =>
  attempt().then(
    () => "",
    (error: unknown) => String(error),
  );

describe("a refusal names the record and the field, never the value", () => {
  it("of a scan, a filter, a retention page, the paused run's save", async () => {
    const { pool } = recordedPool();
    const scans = new PauseScans(pool);
    const after = { at: INVALID, tenantId: "default", pauseId: "r" };
    const filter = { statuses: [PauseStatus.Pending], expiresBefore: INVALID };

    expect(await messageOf(() => scans.pendingDue("expires_at", INVALID, 5))).toContain(
      "at of a pause scan",
    );
    expect(await messageOf(() => scans.pendingDue("expires_at", MID, 5, after))).toContain(
      "after of a pause scan",
    );
    expect(await messageOf(() => scans.reassignedUnsentBefore(INVALID, 5))).toContain(
      "cutoff of a pause scan",
    );
    expect(await messageOf(() => scans.reassignedUnsentBefore(MID, 5, after))).toContain(
      "after of a pause scan",
    );
    expect(await messageOf(() => scans.closedBefore(INVALID, "0", 5))).toContain(
      "cutoff of a pause scan",
    );
    expect(await messageOf(() => scans.deleteClosedBefore(INVALID))).toContain(
      "cutoff of a pause scan",
    );
    expect(await messageOf(() => scans.ofAllTenants(filter, "0", 5))).toContain(
      "expiresBefore of a pause filter",
    );
    expect(await messageOf(() => scans.ofTenant("default", filter, "0", 5))).toContain(
      "expiresBefore of a pause filter",
    );
  });

  it("of a paused run: the pending pause by its place", async () => {
    const run = pausedRunOfJson(JSON.stringify(pausedRun));
    const bad = { ...run, pending: run.pending.map((one) => ({ ...one, expiresAt: INVALID })) };
    const connection = new PostgresConnection({ url: "postgres://u:p@localhost:1/d" });
    try {
      const store = new PostgresPausedExecutionRepository(connection, new VirtualClock());

      const message = await messageOf(() =>
        store.save({ run: bad, workflowVersion: "1", configHash: "h" }),
      );

      expect(message).toContain("pending[0].expiresAt of a paused run");
    } finally {
      await connection.onDestroy();
    }
  });
});

describe("a transition's own times are checked before the first write", () => {
  const key = { tenantId: "default", pauseId: "p" };

  it("the pause it made", async () => {
    const { pool, sent } = recordedPool([[rowOf]]);

    const message = await messageOf(() =>
      transitioned(pool, key, (before) => ({
        pause: { ...before, expiresAt: INVALID },
        notices: [],
      })),
    );

    expect(message).toContain("expiresAt of a pause");
    expect(writes(sent)).toBe(0);
  });

  it("the replacement it inserts, even when the pause it made is fine", async () => {
    const { pool, sent } = recordedPool([[rowOf]]);

    const message = await messageOf(() =>
      transitioned(pool, key, (before) => ({
        pause: before,
        notices: [],
        inserted: { ...before, pauseId: "q", stepKey: "k", askedAt: INVALID },
      })),
    );

    expect(message).toContain("askedAt of a pause");
    expect(writes(sent)).toBe(0);
  });
});

describe("the writes that missed their row name it", () => {
  it("the pause and its tenant are in the message", async () => {
    const { pool } = recordedPool([[rowOf], []]);

    const message = await messageOf(() =>
      new PauseChanges(pool).resolve("default", "p", APPROVED, MID, RECIPIENTS, seenOf(pause)),
    );

    expect(message).toContain("the pause p of default");
  });

  it("a pause already sent is not written again by markSent, and is still pending", async () => {
    const sentPause = { ...pause, isSent: true };
    const { pool, sent } = recordedPool([
      [{ record: JSON.parse(JSON.stringify(sentPause)) as unknown }],
    ]);

    const stillPending = await new PauseTimerChanges(pool).markSent("default", "p", RECIPIENTS);

    expect(stillPending).toBe(true);
    expect(writes(sent)).toBe(0);
  });
});

describe("markSent's statements", () => {
  const LOCK = "SELECT record FROM agboss_pauses WHERE tenant_id = $1 AND pause_id = $2 FOR UPDATE";
  const sendUpdate = (sent: readonly Sent[]): Sent | undefined =>
    sent.find(({ sql }) => sql.startsWith("UPDATE agboss_pauses SET record"));

  it("a pause that is none is not sent, and the lock's read names the tenant and the pause", async () => {
    const { pool, sent } = recordedPool([[]]);

    const isPending = await new PauseTimerChanges(pool).markSent("default", "p", RECIPIENTS);

    expect(isPending).toBe(false);
    expect(sent[1]).toEqual({ sql: LOCK, values: ["default", "p"] });
    expect(writes(sent)).toBe(0);
  });

  it("an unsent pending pause is written as sent, by tenant and pause, and is pending", async () => {
    const { pool, sent } = recordedPool([[rowOf], [{}]]);

    const isPending = await new PauseTimerChanges(pool).markSent("default", "p", RECIPIENTS);

    const update = sendUpdate(sent);
    expect(isPending).toBe(true);
    expect(update?.sql).toBe(
      "UPDATE agboss_pauses SET record = $3::jsonb WHERE tenant_id = $1 AND pause_id = $2",
    );
    expect(update?.values.slice(0, 2)).toEqual(["default", "p"]);
    expect(JSON.parse(String(update?.values[2]))).toMatchObject({ pauseId: "p", isSent: true });
    expect(sent.at(-1)?.sql).toBe("COMMIT");
  });

  it("the write that changed no row is damage, naming the pause", async () => {
    const { pool, sent } = recordedPool([[rowOf], []]);

    const message = await messageOf(() =>
      new PauseTimerChanges(pool).markSent("default", "p", RECIPIENTS),
    );

    expect(message).toContain("the pause p of default");
    expect(sent.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("a pause that closed before it was sent is marked sent and is no longer pending", async () => {
    const closed = {
      ...pause,
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Cancelled,
    };
    const { pool } = recordedPool([
      [{ record: JSON.parse(JSON.stringify(closed)) as unknown }],
      [{}],
    ]);

    const isPending = await new PauseTimerChanges(pool).markSent("default", "p", RECIPIENTS);

    expect(isPending).toBe(false);
  });
});
