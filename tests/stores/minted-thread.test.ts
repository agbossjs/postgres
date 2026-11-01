import { DuplicateThreadIdError, IdGenerator } from "@agboss/core";
import { SequentialIdGenerator, VirtualClock } from "@agboss/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { recordsOn } from "../support/stores.js";

/**
 * agbossjs/agboss#550: a thread id the store mints (no `threadId` given) is never a thread the
 * tenant already has. An `IdGenerator` that repeats ids (two tests minting from `thread-1` on one
 * database, a sequential one restarted on a kept database) used to get the existing thread back
 * from `ON CONFLICT DO NOTHING` — another workflow's (`UnknownThreadError` at the pass), or another
 * owner's of the same workflow (its history joined in silence). The core's stores mint the next id.
 */
const database = testDatabase();

beforeEach(async () => {
  await onSchema(database.url(), "TRUNCATE agboss_threads CASCADE");
});

/** Mints `thread-1` for ever. */
class StuckIdGenerator extends IdGenerator {
  newThreadId(): string {
    return "thread-1";
  }

  newExecutionId(): string {
    return "execution-1";
  }
}

/** What a new minted thread of `desk-workflow` rejects with. */
const exhausted = (records: ReturnType<typeof recordsOn>) =>
  records
    .createThread({ workflow: "desk-workflow", tenantId: "default" })
    .catch((error: unknown) => error);

/** The typed refusal of #613: the project's generator and the tries, never an id. */
function expectExhausted(refused: unknown): void {
  expect(refused).toBeInstanceOf(DuplicateThreadIdError);
  expect(refused).toMatchObject({
    code: "run.duplicate-thread-id",
    generator: "StuckIdGenerator",
    tries: 100,
  });
  expect(String(refused)).not.toContain("thread-1");
}

const sequentialRecords = () =>
  recordsOn(database.url(), new VirtualClock(), new SequentialIdGenerator());

describe("agbossjs/agboss#550: a minted thread id is a new thread", () => {
  it("an id another workflow's thread has is skipped: the next one is minted", async () => {
    const records = sequentialRecords();
    await records.createThread({
      workflow: "credit-workflow",
      tenantId: "default",
      threadId: "thread-1",
    });

    const minted = await records.createThread({
      workflow: "offsite-booking-workflow",
      tenantId: "default",
    });

    expect(minted).toBe("thread-2");
    expect(await records.hasThread("offsite-booking-workflow", "default", minted)).toBe(true);
    expect(await records.hasThread("credit-workflow", "default", "thread-1")).toBe(true);
  });

  it("an id another owner's thread of the same workflow has is skipped: its history stays its own", async () => {
    const records = sequentialRecords();
    await records.createThread({
      workflow: "desk-workflow",
      tenantId: "default",
      ownerId: "alice",
      threadId: "thread-1",
    });

    const minted = await records.createThread({
      workflow: "desk-workflow",
      tenantId: "default",
      ownerId: "bob",
    });

    expect(minted).toBe("thread-2");
    expect(await records.threadOwner("desk-workflow", "default", "thread-1")).toEqual({
      owner: "alice",
    });
    expect(await records.threadOwner("desk-workflow", "default", minted)).toEqual({ owner: "bob" });
  });

  it("another tenant's thread-1 is no collision: each tenant's key is its own", async () => {
    const records = sequentialRecords();
    await records.createThread({
      workflow: "desk-workflow",
      tenantId: "acme",
      threadId: "thread-1",
    });

    expect(await records.createThread({ workflow: "desk-workflow", tenantId: "default" })).toBe(
      "thread-1",
    );
  });

  it("a caller's own id that exists is kept as it was — the first one keeps it", async () => {
    const records = sequentialRecords();
    await records.createThread({
      workflow: "desk-workflow",
      tenantId: "default",
      ownerId: "alice",
      threadId: "mine",
    });

    const again = await records.createThread({
      workflow: "desk-workflow",
      tenantId: "default",
      ownerId: "bob",
      threadId: "mine",
    });

    expect(again).toBe("mine");
    expect(await records.threadOwner("desk-workflow", "default", "mine")).toEqual({
      owner: "alice",
    });
  });

  it("agbossjs/agboss#613: a generator that only repeats a taken id fails after 100 tries with DuplicateThreadIdError", async () => {
    const records = recordsOn(database.url(), new VirtualClock(), new StuckIdGenerator());
    await records.createThread({ workflow: "desk-workflow", tenantId: "default" });

    const refused = await exhausted(records);

    expectExhausted(refused);
  });
});
