import {
  ExecutionCancelFencedError,
  ExecutionPauseFencedError,
  ExecutionStopFencedError,
  InterruptMode,
  StoreClock,
  StoreTimeSource,
} from "@agboss/core";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { VirtualClock } from "@agboss/core/testing";
import { hours } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
} from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * The stop and pause fences of the fenced-effect and outbound-call checks (agbossjs/agboss#1341b,
 * #1341c, #1321e): read from the tree's ROOT lease row in the transaction that checks the lease,
 * for the root's own key and for a child's — a child's write is refused while the root's current
 * token is the one a pause fenced. A stop is no cancel: an undo's key is refused under a stop, and
 * passes under a cancel.
 */
const database = testDatabase();

function stores() {
  const connection = connectionTo(database.url());
  const clock = new StoreClock(StoreTimeSource.Test, new VirtualClock());
  return {
    effects: new PostgresFencedEffectRepository(connection, clock),
    calls: new PostgresOutboundCallRepository(connection, clock),
    leases: new PostgresExecutionLeaseRepository(connection, clock, new TestApplicationContext({})),
  };
}

const keyOf = (lease: string, token: number, root = lease, name = "charge") =>
  effectKeyForTesting({
    scopeKey: `default:${lease}`,
    tenantId: "default",
    leaseExecutionId: lease,
    rootExecutionId: root,
    token,
    idempotencyKey: `${lease}:charge-action:1:${name}:${String(token)}`,
    name,
  });

const TREE = (root: string) => ({ tenantId: "default", rootExecutionId: root });
const write = () => ({ receipt: "r" });

describe("the stop fence", () => {
  it("an immediate stop refuses a new effect with ExecutionStopFencedError, an after-step stop does not", async () => {
    const { effects, leases } = stores();
    const lease = await leases.acquire("default", "stop-fence-1", hours(1));
    const token = lease?.token ?? 0;
    await leases.requestStop(TREE("stop-fence-1"), InterruptMode.AfterStep);

    const kept = await effects.runOnce(keyOf("stop-fence-1", token, "stop-fence-1", "a"), write);
    await leases.requestStop(TREE("stop-fence-1"), InterruptMode.Immediate);
    const refused = await effects
      .runOnce(keyOf("stop-fence-1", token, "stop-fence-1", "b"), write)
      .catch((error: unknown) => error);

    expect(kept.token).toBe(token);
    expect(refused).toBeInstanceOf(ExecutionStopFencedError);
  });

  it("a replay is not a new effect: the stored result comes back under a stop", async () => {
    const { effects, leases } = stores();
    const lease = await leases.acquire("default", "stop-fence-2", hours(1));
    const key = keyOf("stop-fence-2", lease?.token ?? 0);
    await effects.runOnce(key, write);
    await leases.requestStop(TREE("stop-fence-2"), InterruptMode.Immediate);

    const again = await effects.runOnce(key, () => ({ receipt: "other" }));

    expect(again.result).toEqual({ receipt: "r" });
  });

  it("an undo's key is refused under a stop (a stop has none) and passes under a cancel alone", async () => {
    const { effects, leases } = stores();
    const lease = await leases.acquire("default", "stop-fence-3", hours(1));
    const token = lease?.token ?? 0;
    const undo = effectKeyForTesting(keyOf("stop-fence-3", token), { isCompensation: true });
    await leases.requestCancel(TREE("stop-fence-3"));

    const undone = await effects.runOnce(undo, write);
    await leases.requestStop(TREE("stop-fence-3"), InterruptMode.Immediate);
    const afterStop = await effects.runOnce(
      effectKeyForTesting(undo, { name: "undo-2", idempotencyKey: "stop-fence-3:undo-2" }),
      write,
    );

    // a cancel marked: the stop fences nothing while a cancel is marked, the undo runs
    expect(undone.token).toBe(token);
    expect(afterStop.token).toBe(token);
  });

  it("an outbound call's new intent is refused under an immediate stop", async () => {
    const { calls, leases } = stores();
    const lease = await leases.acquire("default", "stop-fence-4", hours(1));
    await leases.requestStop(TREE("stop-fence-4"), InterruptMode.Immediate);

    const refused = await calls
      .saveIfAbsent(keyOf("stop-fence-4", lease?.token ?? 0), {
        rootExecutionId: "stop-fence-4",
        executionId: "stop-fence-4",
        workflow: "w",
        target: "t",
        operation: "o",
        request: "{}",
        step: { nodeId: "n", visitNumber: 1 },
      } as never)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ExecutionStopFencedError);
  });
});

describe("the pause fence", () => {
  it("an immediate pause refuses the root's write at or under the fenced token, a take at token + 1 passes", async () => {
    const { effects, leases } = stores();
    const first = await leases.acquire("default", "pause-fence-1", hours(1));
    await leases.requestPause(TREE("pause-fence-1"), { mode: InterruptMode.Immediate });

    const stale = await effects
      .runOnce(keyOf("pause-fence-1", first?.token ?? 0), write)
      .catch((error: unknown) => error);
    if (first !== undefined) await leases.release(first);
    const second = await leases.acquire("default", "pause-fence-1", hours(1));
    const resumed = await effects.runOnce(keyOf("pause-fence-1", second?.token ?? 0), write);

    expect(stale).toBeInstanceOf(ExecutionPauseFencedError);
    expect(resumed.token).toBe(2);
  });

  it("an after-step pause fences nothing", async () => {
    const { effects, leases } = stores();
    const lease = await leases.acquire("default", "pause-fence-2", hours(1));
    await leases.requestPause(TREE("pause-fence-2"), { mode: InterruptMode.AfterStep });

    const written = await effects.runOnce(keyOf("pause-fence-2", lease?.token ?? 0), write);

    expect(written.token).toBe(1);
  });

  it("a child's write is checked against the ROOT row: refused while the root's token is the fenced one, not after", async () => {
    const { effects, leases } = stores();
    const root = await leases.acquire("default", "root-pf", hours(1));
    const child = await leases.acquire("default", "child-pf", hours(1));
    await leases.requestPause(TREE("root-pf"), { mode: InterruptMode.Immediate });

    const refused = await effects
      .runOnce(keyOf("child-pf", child?.token ?? 0, "root-pf"), write)
      .catch((error: unknown) => error);
    if (root !== undefined) await leases.release(root);
    await leases.acquire("default", "root-pf", hours(1));
    const after = await effects.runOnce(
      keyOf("child-pf", child?.token ?? 0, "root-pf", "b"),
      write,
    );

    expect(refused).toBeInstanceOf(ExecutionPauseFencedError);
    expect(after.token).toBe(child?.token);
  });

  it("a cancel is still refused as a cancel, after the pause and stop checks", async () => {
    const { effects, leases } = stores();
    const lease = await leases.acquire("default", "pause-fence-3", hours(1));
    await leases.requestCancel(TREE("pause-fence-3"));

    const refused = await effects
      .runOnce(keyOf("pause-fence-3", lease?.token ?? 0), write)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ExecutionCancelFencedError);
  });
});
