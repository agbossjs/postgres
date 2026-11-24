import { StatusTrigger, ThreadStatus, type ThreadStatusTransition } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { recordTransitionOf, transitionOf } from "../../src/stores/status-log.js";

/**
 * The rules that say which write is a change of a thread's status (agbossjs/agboss#1341d), pure:
 * the row a change writes, and the transition a record's status write makes.
 */
const THREAD = { tenantId: "acme", threadId: "thread-1" } as const;
const AT = new Date("2026-01-05T09:00:00.000Z");

const row = (toStatus: ThreadStatus, seq = 1): ThreadStatusTransition => ({
  ...THREAD,
  seq,
  fromStatus: null,
  toStatus,
  trigger: StatusTrigger.Start,
  at: AT,
});

describe("transitionOf", () => {
  it("the first change has seq 1 and no from-status", () => {
    const written = transitionOf(
      { ...THREAD, toStatus: ThreadStatus.Running, trigger: StatusTrigger.Start },
      undefined,
      AT,
    );

    expect(written).toEqual({
      ...THREAD,
      seq: 1,
      fromStatus: null,
      toStatus: ThreadStatus.Running,
      trigger: StatusTrigger.Start,
      at: AT,
    });
  });

  it("a change from the last status is one more than its seq, with the command's details", () => {
    const written = transitionOf(
      {
        ...THREAD,
        toStatus: ThreadStatus.Stopping,
        trigger: StatusTrigger.Stop,
        reason: "maintenance",
        actor: "alice",
        leaseToken: 4,
      },
      row(ThreadStatus.Running, 3),
      AT,
    );

    expect(written).toMatchObject({
      seq: 4,
      fromStatus: ThreadStatus.Running,
      reason: "maintenance",
      actor: "alice",
      leaseToken: 4,
    });
  });

  it("a repeat of the thread's status changes nothing", () => {
    const next = {
      ...THREAD,
      toStatus: ThreadStatus.Stopping,
      trigger: StatusTrigger.Stop,
    };

    expect(transitionOf(next, row(ThreadStatus.Stopping), AT)).toBeUndefined();
  });

  it.each([ThreadStatus.Stopping, ThreadStatus.Cancelling])(
    "a record moving through running while the thread is %s does not make it run again",
    (under) => {
      const next = { ...THREAD, toStatus: ThreadStatus.Running, trigger: StatusTrigger.Start };

      expect(transitionOf(next, row(under), AT)).toBeUndefined();
    },
  );

  it("running again after a pause is written", () => {
    const next = { ...THREAD, toStatus: ThreadStatus.Running, trigger: StatusTrigger.Resume };

    expect(transitionOf(next, row(ThreadStatus.Paused), AT)).toMatchObject({
      fromStatus: ThreadStatus.Paused,
      toStatus: ThreadStatus.Running,
    });
  });
});

describe("recordTransitionOf", () => {
  it.each([
    ["running", ThreadStatus.Running, StatusTrigger.Start],
    ["paused", ThreadStatus.Paused, StatusTrigger.Ask],
    ["answered", ThreadStatus.Finished, StatusTrigger.Finish],
    ["guarded", ThreadStatus.Finished, StatusTrigger.Finish],
    ["failed", ThreadStatus.Failed, StatusTrigger.Fail],
    ["stopped", ThreadStatus.Stopped, StatusTrigger.Stop],
    ["cancelled", ThreadStatus.Cancelled, StatusTrigger.Cancel],
  ])("a %s record makes the thread %s, by %s", (recordStatus, toStatus, trigger) => {
    expect(recordTransitionOf(THREAD, recordStatus, undefined, undefined)).toEqual({
      ...THREAD,
      toStatus,
      trigger,
    });
  });

  it.each(["queued", "written", "unknown"])("a %s record is no thread status", (recordStatus) => {
    expect(recordTransitionOf(THREAD, recordStatus, undefined, undefined)).toBeUndefined();
  });

  it("a record running again after a business pause is a resume, also after both pauses", () => {
    for (const was of [ThreadStatus.Paused, ThreadStatus.DualPaused])
      expect(recordTransitionOf(THREAD, "running", row(was), undefined)).toMatchObject({
        trigger: StatusTrigger.Resume,
      });
  });

  it("a command's context names the status, the trigger and the details of its write", () => {
    const written = recordTransitionOf(THREAD, "paused", undefined, {
      toStatus: ThreadStatus.ExternallyPaused,
      trigger: StatusTrigger.Pause,
      reason: "freeze",
      actor: "ops",
      leaseToken: 2,
    });

    expect(written).toEqual({
      ...THREAD,
      toStatus: ThreadStatus.ExternallyPaused,
      trigger: StatusTrigger.Pause,
      reason: "freeze",
      actor: "ops",
      leaseToken: 2,
    });
  });
});
