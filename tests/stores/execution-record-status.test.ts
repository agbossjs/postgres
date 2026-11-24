import { ExecutionRecordStatus, InterruptMode, StatusTrigger, ThreadStatus } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { minutes } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { outcomeOf, recordOf, recordsOn } from "../support/stores.js";

/**
 * The thread's status history written in the transaction of each record write, and the sweep of
 * idle threads (agbossjs/agboss#1341d, #1303c): what the core's Turn store does on SQLite, on
 * PostgreSQL.
 */
const database = testDatabase();
const { Answered, Running, Paused, Failed } = ExecutionRecordStatus;

const statusesOf = async (records: ReturnType<typeof recordsOn>, threadId: string) =>
  (await records.statusHistory("default", threadId)).map((row) => [row.toStatus, row.trigger]);

describe("the status history of a thread", () => {
  it("append, complete and completeIfStatus each write the change they make, in order", async () => {
    const records = recordsOn(database.url());
    const threadId = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });
    const first = await records.append(recordOf(threadId, Running));

    await records.complete(first.id, outcomeOf(Paused));
    const resumed = await records.completeIfStatus(first.id, Paused, outcomeOf(Running));
    const late = await records.completeIfStatus(first.id, Paused, outcomeOf(Failed));
    await records.complete(first.id, outcomeOf(Answered));

    expect(resumed).toBe(true);
    expect(late).toBe(false);
    expect(await statusesOf(records, threadId)).toEqual([
      [ThreadStatus.Running, StatusTrigger.Start],
      [ThreadStatus.Paused, StatusTrigger.Ask],
      [ThreadStatus.Running, StatusTrigger.Resume],
      [ThreadStatus.Finished, StatusTrigger.Finish],
    ]);
  });

  it("a write that leaves the status as it was, a queued record and a written one add no row", async () => {
    const records = recordsOn(database.url());
    const threadId = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });
    const first = await records.append(recordOf(threadId, Running));

    await records.complete(first.id, outcomeOf(Running));
    await records.append(recordOf(threadId, ExecutionRecordStatus.Queued));
    await records.append(recordOf(threadId, ExecutionRecordStatus.Written));

    expect(await statusesOf(records, threadId)).toEqual([
      [ThreadStatus.Running, StatusTrigger.Start],
    ]);
  });

  it("a command's context names the status, the trigger and the details of the row", async () => {
    const records = recordsOn(database.url());
    const threadId = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });
    const first = await records.append(recordOf(threadId, Running));

    await records.complete(first.id, outcomeOf(Paused), {
      toStatus: ThreadStatus.ExternallyPaused,
      trigger: StatusTrigger.Pause,
      reason: "freeze",
      actor: "ops",
      leaseToken: 3,
    });

    expect((await records.statusHistory("default", threadId)).at(-1)).toMatchObject({
      seq: 2,
      fromStatus: ThreadStatus.Running,
      toStatus: ThreadStatus.ExternallyPaused,
      trigger: StatusTrigger.Pause,
      reason: "freeze",
      actor: "ops",
      leaseToken: 3,
    });
  });

  it("a record running while the thread is stopping does not make it run again", async () => {
    const records = recordsOn(database.url());
    const threadId = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });
    const first = await records.append(recordOf(threadId, Paused));

    await records.complete(first.id, outcomeOf(Failed), {
      toStatus: ThreadStatus.Stopping,
      trigger: StatusTrigger.Stop,
    });
    await records.complete(first.id, outcomeOf(Running));

    expect((await statusesOf(records, threadId)).at(-1)).toEqual([
      ThreadStatus.Stopping,
      StatusTrigger.Stop,
    ]);
    expect(InterruptMode.Immediate).toBe("immediate");
  });

  it("two writers of one thread at once never write one seq twice", async () => {
    const [a, b] = [recordsOn(database.url()), recordsOn(database.url())];
    const threadId = await a.createThread({ workflow: "desk-workflow", tenantId: "default" });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? a : b).append(recordOf(threadId, index % 4 < 2 ? Running : Failed)),
      ),
    );

    const seqs = (await a.statusHistory("default", threadId)).map((row) => row.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  it("forgetStatusHistory removes the thread's rows and no other thread's", async () => {
    const records = recordsOn(database.url());
    const one = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });
    const two = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });
    await records.append(recordOf(one, Running));
    await records.append(recordOf(two, Running));

    await records.forgetStatusHistory("default", one);
    await records.forgetStatusHistory("default", "no-such-thread");

    expect(await records.statusHistory("default", one)).toEqual([]);
    expect(await records.statusHistory("default", two)).toHaveLength(1);
  });
});

describe("the sweep of idle threads (agbossjs/agboss#1303c)", () => {
  const ended = () => Promise.resolve(true);

  async function idle(workflow: string, ownerId?: string) {
    const clock = new VirtualClock();
    const records = recordsOn(database.url(), clock);
    const threadId = await records.createThread({
      workflow,
      tenantId: "default",
      ...(ownerId === undefined ? {} : { ownerId }),
    });
    await records.append(recordOf(threadId, Answered, { workflow }));
    await clock.advance(minutes(10));
    return { records, threadId, cutoffs: new Map([[workflow, clock.now()]]) };
  }

  it("empties an owned thread to a tombstone only its owner can restart; an ownerless one goes whole", async () => {
    const owned = await idle("sweep-1", "alice");
    const ownerless = await idle("sweep-1");

    expect(await owned.records.deleteIdleThreads(owned.cutoffs, ended)).toBe(2);

    expect(await owned.records.lastTurns("default", owned.threadId, 10)).toEqual([]);
    expect(await owned.records.statusHistory("default", owned.threadId)).toEqual([]);
    expect(await owned.records.threadOwner("sweep-1", "default", owned.threadId)).toEqual({
      owner: "alice",
      isSwept: true,
    });
    expect(
      await ownerless.records.threadOwner("sweep-1", "default", ownerless.threadId),
    ).toBeUndefined();
    await expect(
      owned.records.append(recordOf(owned.threadId, Running, { workflow: "sweep-1" })),
    ).rejects.toThrow(/swept/);
    await expect(
      owned.records.createThread({
        workflow: "sweep-1",
        tenantId: "default",
        threadId: owned.threadId,
        ownerId: "mallory",
      }),
    ).rejects.toThrow(/another owner/);
    await owned.records.createThread({
      workflow: "sweep-1",
      tenantId: "default",
      threadId: owned.threadId,
      ownerId: "alice",
    });
    await owned.records.append(recordOf(owned.threadId, Running, { workflow: "sweep-1" }));
    expect(await owned.records.lastTurns("default", owned.threadId, 10)).toHaveLength(1);
  });

  it("keeps a thread with a record running, paused or queued, or a run the tree store does not end", async () => {
    const live = await idle("sweep-2");
    await live.records.append(recordOf(live.threadId, Paused, { workflow: "sweep-2" }));
    const unfinished = await idle("sweep-3");

    const removed = await live.records.deleteIdleThreads(live.cutoffs, ended);
    const notEnded = await unfinished.records.deleteIdleThreads(unfinished.cutoffs, () =>
      Promise.resolve(false),
    );

    expect(removed).toBe(0);
    expect(notEnded).toBe(0);
    expect(await live.records.lastTurns("default", live.threadId, 10)).toHaveLength(2);
  });

  it("a thread active since the cutoff, or of another workflow, is kept", async () => {
    const clock = new VirtualClock();
    const records = recordsOn(database.url(), clock);
    const threadId = await records.createThread({ workflow: "sweep-4", tenantId: "default" });
    await records.append(recordOf(threadId, Answered, { workflow: "sweep-4" }));

    const early = await records.deleteIdleThreads(
      new Map([["sweep-4", new Date(clock.now().getTime() - 1)]]),
      ended,
    );
    const other = await records.deleteIdleThreads(
      new Map([["other-workflow", new Date(clock.now().getTime() + 1)]]),
      ended,
    );

    expect([early, other]).toEqual([0, 0]);
    const { rows } = await onSchema(
      database.url(),
      "SELECT count(*)::int AS n FROM agboss_threads",
    );
    expect((rows[0] as { n: number }).n).toBeGreaterThan(0);
  });
});
