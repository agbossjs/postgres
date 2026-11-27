import { ExecutionRecordStatus } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { statusPageOf } from "../../src/stores/records/record-reads.js";
import { recordedPool } from "./recorded-pool.js";

/**
 * The page of the records of a status (recovery's look-up), with no database: one more than the page
 * is read to know whether another follows, the cursor is the last record of the page, a limit is a
 * positive whole number.
 */
const rowOf = (id: string) => ({
  id,
  run_id: null,
  tenant_id: "default",
  thread_id: "thread-1",
  workflow: "desk-workflow",
  created_at: new Date("2026-01-05T09:00:00.000Z"),
  task: "t",
  reply_with: "r",
  status: "running",
  stop_reason: "",
  route: [],
  steps: [],
  cost_usd: 0,
  prompt_version: "p",
  model_version: "m",
  replay_of: null,
  config_version: null,
  config_hash: null,
});
const RUNNING = ExecutionRecordStatus.Running;

describe("statusPageOf", () => {
  it("reads one more than the limit, shows the limit, and names the last shown as the cursor", async () => {
    const { pool, sent } = recordedPool([[rowOf("a"), rowOf("b"), rowOf("c")]]);

    const page = await statusPageOf(pool, { status: RUNNING, limit: 2, cursor: "z" });

    expect(page.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe("b");
    expect(sent[0]?.values).toEqual(["running", "z", 3]);
  });

  it("a page of exactly the limit has no next one; a short page neither; none is empty", async () => {
    const exact = await statusPageOf(recordedPool([[rowOf("a"), rowOf("b")]]).pool, {
      status: RUNNING,
      limit: 2,
    });
    const short = await statusPageOf(recordedPool([[rowOf("a")]]).pool, {
      status: RUNNING,
      limit: 2,
    });
    const none = await statusPageOf(recordedPool([[]]).pool, { status: RUNNING, limit: 2 });

    expect(exact.items).toHaveLength(2);
    expect(exact).not.toHaveProperty("nextCursor");
    expect(short).not.toHaveProperty("nextCursor");
    expect(none).toEqual({ items: [] });
  });

  it("without a limit a page is a hundred, read as a hundred and one; a limit of one is allowed", async () => {
    const { pool, sent } = recordedPool([[]]);
    await statusPageOf(pool, { status: RUNNING });
    const one = recordedPool([[rowOf("a"), rowOf("b")]]);

    const page = await statusPageOf(one.pool, { status: RUNNING, limit: 1 });

    expect(sent[0]?.values).toEqual(["running", null, 101]);
    expect(page.items.map((item) => item.id)).toEqual(["a"]);
    expect(page.nextCursor).toBe("a");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "a limit of %s is refused naming what a limit is, and nothing is read",
    async (limit) => {
      const { pool, sent } = recordedPool();

      await expect(statusPageOf(pool, { status: RUNNING, limit })).rejects.toThrow(
        new RangeError("a page's limit is a positive whole number"),
      );

      expect(sent).toEqual([]);
    },
  );
});
