import {
  ComponentKind,
  PauseResolution,
  type PauseAnswerRecord,
  type PauseTrailEntry,
} from "@agboss/core";
import { PauseRespondent, pauseAnswerRecordOfValue, StoreError } from "@agboss/core/stores";
import { afterEach, describe, expect, it } from "vitest";
import {
  markPauseAnswerNotTaken,
  savePauseAnswer,
} from "../../src/stores/records/record-writes.js";
import { recordedPool } from "./recorded-pool.js";

/**
 * The answer log's `asked_at text` (agbossjs/agboss#1307, P6b): bound as the `toISOString()` text of
 * the record's `Date`, so the column sorts by instant in any process time zone (the P6a mistake was
 * the `Date` itself, which node-postgres writes in local time with an offset); an Invalid Date is
 * refused before the statement.
 */
const ZONE = process.env.TZ;
afterEach(() => {
  if (ZONE === undefined) delete process.env.TZ;
  else process.env.TZ = ZONE;
});

const answerAt = (askedAt: string, trailAt = askedAt): PauseAnswerRecord =>
  pauseAnswerRecordOfValue({
    pauseId: undefined,
    executionId: "run-1",
    step: {
      component: { name: "clerk-agent", kind: ComponentKind.Agent },
      nodeId: "clerk-agent",
      visitNumber: 1,
      idempotencyKey: "run-1:clerk:1",
      callId: "call-1",
      itemIndex: undefined,
      copyNumber: 1,
      toolLoopIteration: 2,
      validationAttempts: 0,
    },
    target: "refund-tool-approval",
    respondent: PauseRespondent.Delegate,
    actor: { id: "manager-17" },
    resolution: PauseResolution.Replied,
    askedAt,
    resolvedAt: "2026-03-29T01:00:00.000Z",
    decision: { approved: true },
    input: {},
    trail: [{ action: "opened", at: trailAt, target: "refund-tool-approval" }],
  });

describe("the answer log's column", () => {
  for (const zone of ["UTC", "Asia/Jerusalem", "America/New_York"])
    for (const write of [savePauseAnswer, markPauseAnswerNotTaken])
      it(`${zone} ${write.name}: asked_at is the ISO text, the JSON holds the same text`, async () => {
        process.env.TZ = zone;
        const { pool, sent } = recordedPool();

        await write(pool, "default", "root-1", answerAt("2026-03-29T00:30:00.123Z"));

        expect(sent[0]?.values[3]).toBe("2026-03-29T00:30:00.123Z");
        expect(JSON.parse(String(sent[0]?.values[4]))).toMatchObject({
          askedAt: "2026-03-29T00:30:00.123Z",
          resolvedAt: "2026-03-29T01:00:00.000Z",
        });
      });

  it("refuses an Invalid Date in any time of the entry, writing nothing", async () => {
    const { pool, sent } = recordedPool();
    const good = answerAt("2026-03-29T00:30:00.123Z");
    const [entry] = good.trail as [PauseTrailEntry];
    const bad = new Date(Number.NaN);
    const entries = [
      { ...good, askedAt: bad },
      { ...good, resolvedAt: bad },
      { ...good, trail: [{ ...entry, at: bad }] },
      { ...good, trail: [{ ...entry, expiresAt: bad }] },
    ];

    for (const entry of entries) {
      await expect(savePauseAnswer(pool, "default", "root-1", entry)).rejects.toBeInstanceOf(
        StoreError.UnreadableRecord,
      );
      await expect(
        markPauseAnswerNotTaken(pool, "default", "root-1", entry),
      ).rejects.toBeInstanceOf(StoreError.UnreadableRecord);
    }
    expect(sent).toHaveLength(0);
  });
});
