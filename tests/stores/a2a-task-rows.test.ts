import { A2ATaskState } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { taskOf } from "../../src/stores/a2a-tasks/a2a-task-rows.js";

/**
 * The task a row reads as, with no database: a status's `cancelRequestedAt` is stored as its ISO text
 * and read back as the `Date` it was written from, one that is no ISO time is refused (agbossjs/agboss#810,
 * mutation shard a2a-tasks).
 */
const WHEN = new Date("2026-01-05T09:00:00.000Z");
const rowWith = (status: object) => ({
  endpoint: "orders",
  tenant_id: "default",
  task_id: "t-1",
  owner_id: "",
  context_id: "c-1",
  skill: "refund",
  state: A2ATaskState.Working,
  status: { state: A2ATaskState.Working, pendingPauses: [], ...status },
  version: 1,
  accepted_at: WHEN,
  status_at: WHEN,
  caller_peer: null,
  mesh_body_hash: null,
});

describe("a task's status as a row reads it", () => {
  it("reads cancelRequestedAt as the Date it was written from", () => {
    const read = taskOf(rowWith({ cancelRequestedAt: "2026-01-05T09:30:00.123Z" }));

    expect(read.status.cancelRequestedAt).toBeInstanceOf(Date);
    expect(read.status.cancelRequestedAt).toEqual(new Date("2026-01-05T09:30:00.123Z"));
  });

  it("has none when the status has none, and refuses a text that is no ISO time", () => {
    expect(taskOf(rowWith({})).status).not.toHaveProperty("cancelRequestedAt");
    expect(() => taskOf(rowWith({ cancelRequestedAt: "yesterday" }))).toThrow();
  });
});
