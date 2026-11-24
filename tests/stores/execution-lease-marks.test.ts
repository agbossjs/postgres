import {
  ClusterLeaseSyncOutcome,
  MirroredLeaseState,
  type ExecutionLease,
} from "@agboss/core/stores";
import {
  InterruptMode,
  RandomIdGenerator,
  StatusTrigger,
  StoreClock,
  StoreTimeSource,
  ThreadStatus,
  type NewStatusTransition,
} from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { hours } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresExecutionRecordRepository,
} from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * The stop and pause marks and the cluster mirror on the lease row (agbossjs/agboss#1341b, #1341c,
 * #1321e), past the contract: each mark is one transaction with its thread's history row, the
 * fence only rises and is never cleared, and the mirror writes a cluster's lease in one upsert that
 * keeps the marks. The DB row is the authority (D6).
 */
const database = testDatabase();

const TREE = (root: string) => ({ tenantId: "default", rootExecutionId: root });

const leasesOn = (instanceId = "instance-1") => {
  const connection = connectionTo(database.url());
  const clock = new StoreClock(StoreTimeSource.Test, new VirtualClock());
  return {
    connection,
    leases: new PostgresExecutionLeaseRepository(
      connection,
      clock,
      new TestApplicationContext({}, instanceId),
    ),
    records: new PostgresExecutionRecordRepository(
      connection,
      new VirtualClock(),
      new TestApplicationContext({}, instanceId),
      new RandomIdGenerator(),
    ),
  };
};

const change = (
  thread: string,
  toStatus: ThreadStatus,
  trigger: StatusTrigger,
): NewStatusTransition => ({
  tenantId: "default",
  threadId: thread,
  toStatus,
  trigger,
});

const rowOf = async (root: string) =>
  (
    await onSchema(
      database.url(),
      "SELECT * FROM agboss_execution_leases WHERE tenant_id = 'default' AND root_execution_id = $1",
      [root],
    )
  ).rows[0] as Record<string, unknown> | undefined;

describe("the stop mark", () => {
  it("is on a seed row before the first take, escalates after-step to immediate and never back", async () => {
    const { leases } = leasesOn();

    await leases.requestStop(TREE("stop-1"), InterruptMode.AfterStep);
    expect(await leases.stopOf(TREE("stop-1"))).toEqual({ mode: InterruptMode.AfterStep });
    await leases.requestStop(TREE("stop-1"), InterruptMode.Immediate);
    await leases.requestStop(TREE("stop-1"), InterruptMode.AfterStep);

    expect(await leases.stopOf(TREE("stop-1"))).toEqual({ mode: InterruptMode.Immediate });
    expect(await rowOf("stop-1")).toMatchObject({
      token: 0,
      released: true,
      stop_mode: "immediate",
    });
    expect(await leases.stopOf(TREE("never"))).toBeUndefined();
    const taken = await leases.acquire("default", "stop-1", hours(1));
    expect(taken).toMatchObject({ token: 1 });
    expect(taken?.takenOverFrom).toBeUndefined();
    expect(await leases.stopOf(TREE("stop-1"))).toEqual({ mode: InterruptMode.Immediate });
  });

  it("writes the history row in its own transaction, only when it set or escalated the mark", async () => {
    const { leases, records } = leasesOn();
    const stopping = change("t-stop", ThreadStatus.Stopping, StatusTrigger.Stop);

    await leases.requestStop(TREE("stop-h"), InterruptMode.AfterStep, stopping);
    await leases.requestStop(TREE("stop-h"), InterruptMode.AfterStep, stopping);
    await leases.requestStop(TREE("stop-h"), InterruptMode.Immediate, stopping);

    const history = await records.statusHistory("default", "t-stop");
    expect(history.map((row) => [row.seq, row.toStatus, row.trigger])).toEqual([
      [1, ThreadStatus.Stopping, StatusTrigger.Stop],
    ]);
  });

  it("a history row that cannot be written rolls the mark back with it", async () => {
    const { leases } = leasesOn();
    await onSchema(database.url(), "ALTER TABLE agboss_thread_status_transitions RENAME TO moved");
    try {
      await expect(
        leases.requestStop(
          TREE("stop-atomic"),
          InterruptMode.Immediate,
          change("t-atomic", ThreadStatus.Stopping, StatusTrigger.Stop),
        ),
      ).rejects.toThrow();
      expect(await rowOf("stop-atomic")).toBeUndefined();
    } finally {
      await onSchema(
        database.url(),
        "ALTER TABLE moved RENAME TO agboss_thread_status_transitions",
      );
    }
  });
});

describe("the external pause and its fence", () => {
  it("an immediate pause fences through the row's token; an after-step one fences nothing", async () => {
    const { leases } = leasesOn();
    await leases.acquire("default", "pause-1", hours(1));

    await leases.requestPause(TREE("pause-1"), { mode: InterruptMode.AfterStep, reason: "look" });
    expect(await leases.pauseOf(TREE("pause-1"))).toEqual({
      pause: { reason: "look", mode: InterruptMode.AfterStep },
    });
    await leases.requestPause(TREE("pause-1"), { mode: InterruptMode.Immediate });

    expect(await leases.pauseOf(TREE("pause-1"))).toEqual({
      pause: { mode: InterruptMode.Immediate },
      fencedThroughToken: 1,
    });
  });

  it("the fence only rises: GREATEST of itself and the row's token, kept after the unpause", async () => {
    const { leases } = leasesOn();
    const first = await leases.acquire("default", "pause-2", hours(1));
    await leases.requestPause(TREE("pause-2"), { mode: InterruptMode.Immediate });
    if (first !== undefined) await leases.release(first);
    const second = await leases.acquire("default", "pause-2", hours(1));
    expect(second).toMatchObject({ token: 2 });

    await leases.unpause(TREE("pause-2"));
    expect(await leases.pauseOf(TREE("pause-2"))).toEqual({ fencedThroughToken: 1 });
    await leases.requestPause(TREE("pause-2"), { mode: InterruptMode.Immediate });
    await leases.requestPause(TREE("pause-2"), { mode: InterruptMode.AfterStep });

    expect(await leases.pauseOf(TREE("pause-2"))).toEqual({
      pause: { mode: InterruptMode.Immediate },
      fencedThroughToken: 2,
    });
  });

  it("unpause of a tree not paused is a no-op with no history row; a pause and its lift write one each", async () => {
    const { leases, records } = leasesOn();
    const paused = change("t-pause", ThreadStatus.ExternallyPaused, StatusTrigger.Pause);
    const running = change("t-pause", ThreadStatus.Running, StatusTrigger.Unpause);

    await leases.unpause(TREE("pause-3"), running);
    await leases.requestPause(TREE("pause-3"), { mode: InterruptMode.AfterStep }, paused);
    await leases.requestPause(TREE("pause-3"), { mode: InterruptMode.AfterStep }, paused);
    await leases.unpause(TREE("pause-3"), running);

    expect((await records.statusHistory("default", "t-pause")).map((row) => row.toStatus)).toEqual([
      ThreadStatus.ExternallyPaused,
      ThreadStatus.Running,
    ]);
  });

  it("a reason with a NUL character is kept as given", async () => {
    const { leases } = leasesOn();

    await leases.requestPause(TREE("pause-nul"), {
      mode: InterruptMode.AfterStep,
      reason: "a\u0000b",
    });

    expect((await leases.pauseOf(TREE("pause-nul"))).pause?.reason).toBe("a\u0000b");
  });
});

describe("markedOf", () => {
  it("answers the cancel, the stop and the pause of the row in one read", async () => {
    const { leases } = leasesOn();
    await leases.acquire("default", "marked-1", hours(1));
    expect(await leases.markedOf(TREE("marked-1"))).toEqual({ isCancelRequested: false });
    await leases.requestCancel(TREE("marked-1"));
    await leases.requestStop(TREE("marked-1"), InterruptMode.AfterStep);
    await leases.requestPause(TREE("marked-1"), { mode: InterruptMode.Immediate, reason: "r" });

    expect(await leases.markedOf(TREE("marked-1"))).toEqual({
      isCancelRequested: true,
      stop: { mode: InterruptMode.AfterStep },
      pause: { reason: "r", mode: InterruptMode.Immediate },
      fencedThroughToken: 1,
    });
  });
});

describe("the cluster mirror (agbossjs/agboss#1321e)", () => {
  const leaseOf = (root: string, token: number, holder = "instance-1"): ExecutionLease => ({
    tenantId: "default",
    rootExecutionId: root,
    holderInstanceId: holder,
    token,
    expiresAt: new Date(0),
    remaining: 0 as ExecutionLease["remaining"],
  });

  it("writes the lease into the row, live for good, keeping the marks, never lowering the token", async () => {
    const { leases } = leasesOn();
    await leases.requestStop(TREE("mirror-1"), InterruptMode.Immediate);
    await leases.requestPause(TREE("mirror-1"), { mode: InterruptMode.Immediate });

    expect(await leases.syncClusterLease(leaseOf("mirror-1", 3))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Synced,
    });
    expect(await leases.syncClusterLease(leaseOf("mirror-1", 3))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Synced,
    });
    expect(await leases.syncClusterLease(leaseOf("mirror-1", 2))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Behind,
      rowToken: 3,
    });
    expect(await leases.syncClusterLease(leaseOf("mirror-1", 3, "instance-2"))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Behind,
      rowToken: 3,
    });

    expect(await leases.mirroredLeaseOf(TREE("mirror-1"))).toEqual({
      token: 3,
      holderInstanceId: "instance-1",
      state: MirroredLeaseState.Held,
    });
    expect(await leases.markedOf(TREE("mirror-1"))).toMatchObject({
      stop: { mode: InterruptMode.Immediate },
      pause: { mode: InterruptMode.Immediate },
    });
  });

  it("a released row at the token is behind; the holder's own end, released or retired, keeps the others' rows", async () => {
    const { leases } = leasesOn();
    await leases.syncClusterLease(leaseOf("mirror-2", 1));

    await leases.endClusterLease(leaseOf("mirror-2", 1, "instance-2"), { isRetired: false });
    expect((await leases.mirroredLeaseOf(TREE("mirror-2")))?.state).toBe(MirroredLeaseState.Held);
    await leases.endClusterLease(leaseOf("mirror-2", 1), { isRetired: false });
    expect((await leases.mirroredLeaseOf(TREE("mirror-2")))?.state).toBe(
      MirroredLeaseState.Released,
    );
    expect(await leases.syncClusterLease(leaseOf("mirror-2", 1))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Behind,
      rowToken: 1,
    });
    expect(await leases.syncClusterLease(leaseOf("mirror-2", 2))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Synced,
    });
    await leases.endClusterLease(leaseOf("mirror-2", 2), { isRetired: true });

    expect((await leases.mirroredLeaseOf(TREE("mirror-2")))?.state).toBe(
      MirroredLeaseState.Retired,
    );
    expect(await leases.syncClusterLease(leaseOf("mirror-2", 9))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Retired,
    });
    expect(await leases.mirroredLeaseOf(TREE("no-row"))).toBeUndefined();
  });

  it("a seed row (a mark before the first take) is taken over like a released one", async () => {
    const { leases } = leasesOn();
    await leases.requestCancel(TREE("mirror-3"));

    expect(await leases.syncClusterLease(leaseOf("mirror-3", 1))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Synced,
    });
    expect(await leases.isCancelRequested(TREE("mirror-3"))).toBe(true);
  });
});
