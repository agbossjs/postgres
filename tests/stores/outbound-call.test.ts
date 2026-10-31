import {
  ExecutionFencedError,
  OutboundCallLeaseState,
  OutboundCallStatus,
  type ExecutionLease,
  type FencedEffectKey,
  type OutboundCallIntent,
} from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { hours, seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresOutboundCallRepository,
} from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * `PostgresOutboundCallRepository` beyond the contract (agbossjs/agboss#505, #508): many
 * connections racing on one business key, one intent and one lease, round after round — more
 * callers than the contract's two; a check-then-write port beside it, which the same race catches;
 * NUL characters in the matched columns; a pool of one; a row that is not a record; a lost database.
 */
const database = testDatabase();

/** Racers per round, and rounds per race: each racer an instance with a pool of its own. */
const RACERS = 6;
const ROUNDS = 15;

function instanceOn(clock: VirtualClock, index: number, poolSize = 2) {
  const connection = connectionTo(database.url(), poolSize);
  const application = new TestApplicationContext({}, `instance-${String(index)}`);
  return {
    calls: new PostgresOutboundCallRepository(connection, clock),
    leases: new PostgresExecutionLeaseRepository(connection, clock, application),
  };
}

const instancesOn = (clock: VirtualClock) =>
  Array.from({ length: RACERS }, (_, index) => instanceOn(clock, index));

const keyOf = (lease: ExecutionLease, extra: Partial<FencedEffectKey> = {}): FencedEffectKey => ({
  scopeKey: `${lease.tenantId}:${lease.rootExecutionId}`,
  tenantId: lease.tenantId,
  leaseExecutionId: lease.rootExecutionId,
  token: lease.leaseEpoch,
  idempotencyKey: `${lease.rootExecutionId}:charge-action:1`,
  name: "charge",
  ...extra,
});

const intentOf = (key: FencedEffectKey, owner = "owner-1"): OutboundCallIntent => ({
  rootExecutionId: key.leaseExecutionId,
  executionId: key.leaseExecutionId,
  workflow: "charge-workflow",
  target: "payments",
  operation: "charge",
  idempotencyKey: `${key.idempotencyKey}:${key.name}`,
  request: '{"orderId":"order-7"}',
  attempt: 1,
  attemptOwner: owner,
  step: { nodeId: "charge-action", visitNumber: 1 },
});

async function leaseOf(
  stores: ReturnType<typeof instanceOn>,
  root: string,
  length = hours(1),
): Promise<ExecutionLease> {
  const lease = await stores.leases.acquire("default", root, length);
  if (lease === undefined) throw new Error(`the lease of ${root} is held`);
  return lease;
}

/** Each instance with the lease of a tree of its own, `<prefix>-<index>`. */
const withLeases = (instances: ReturnType<typeof instanceOn>[], prefix: string) =>
  Promise.all(
    instances.map(async (stores, index) => ({
      ...stores,
      lease: await leaseOf(stores, `${prefix}-${String(index)}`),
    })),
  );

const NO_LEASE: ExecutionLease = {
  tenantId: "default",
  rootExecutionId: "none",
  holderInstanceId: "none",
  leaseEpoch: 1,
  expiresAt: new Date(0),
};

const PENDING = { status: OutboundCallStatus.Pending, attempt: 1, attemptOwner: "owner-1" };

describe("PostgresOutboundCallRepository: many connections racing", () => {
  it("#508: six executions on six instances saving one business key at once, round after round: one intent", async () => {
    const instances = await withLeases(instancesOn(new VirtualClock()), "save");

    for (let round = 0; round < ROUNDS; round += 1) {
      const businessKey = `order:${String(round)}`;
      const saves = await Promise.all(
        instances.map((stores) => {
          const key = keyOf(stores.lease, { businessKey, fingerprint: "f" });
          return stores.calls.saveIfAbsent(key, intentOf(key));
        }),
      );

      expect(saves.filter(Boolean)).toHaveLength(1);
    }
    const { rows } = await onSchema(
      database.url(),
      "SELECT count(*)::int AS n FROM agboss_outbound_calls WHERE business_key LIKE 'order:%'",
    );
    expect(rows).toEqual([{ n: ROUNDS }]);
  });

  it("#508: six instances moving one business key's intent from one read under six leases: exactly one wins", async () => {
    const instances = await withLeases(instancesOn(new VirtualClock()), "move");
    const keyAt = (index: number, round: number) =>
      keyOf((instances[index] ?? instances[0])?.lease ?? NO_LEASE, {
        businessKey: `move:${String(round)}`,
        fingerprint: "f",
      });

    for (let round = 0; round < ROUNDS; round += 1) {
      await instances[0]?.calls.saveIfAbsent(keyAt(0, round), intentOf(keyAt(0, round)));
      const moves = await Promise.all(
        instances.map((stores, index) =>
          index % 2 === 0
            ? stores.calls.markPending(keyAt(index, round), PENDING, {
                attempt: 2,
                attemptOwner: `owner-${String(index)}`,
              })
            : stores.calls.markCompleted(keyAt(index, round), "owner-1", `"by-${String(index)}"`),
        ),
      );

      expect(moves.filter(Boolean)).toHaveLength(1);
      const winner = moves.indexOf(true);
      const found = await instances[1]?.calls.findByKey(keyAt(1, round));
      expect(found).toMatchObject({ leaseExecutionId: `move-${String(winner)}` });
    }
  });

  it("#508: leaseStateOf on five instances racing the holder's renewal of its expired lease: renewed and Live everywhere, or one Superseded and the rest Ended", async () => {
    const clock = new VirtualClock();
    const [holder, ...checkers] = instancesOn(clock);
    if (holder === undefined) throw new Error("six instances");

    for (let round = 0; round < ROUNDS; round += 1) {
      const root = `state-${String(round)}`;
      const lease = await leaseOf(holder, root, seconds(30));
      await clock.advance(seconds(31));
      const state = { tenantId: "default", leaseExecutionId: root, token: lease.leaseEpoch };

      const [isRenewed, ...states] = await Promise.all([
        holder.leases.renew(lease, seconds(30)),
        ...checkers.map((stores) => stores.calls.leaseStateOf(state)),
      ]);

      const { Live, Ended, Superseded } = OutboundCallLeaseState;
      const superseded = states.filter((found) => found === Superseded);
      if (isRenewed) expect(states.every((found) => found === Live)).toBe(true);
      else {
        expect(superseded).toHaveLength(1);
        expect(states.filter((found) => found === Ended)).toHaveLength(states.length - 1);
      }
      expect(await holder.leases.renew(lease, seconds(30))).toBe(isRenewed);
    }
  });

  it("a check-then-write port of markPending (read, then write by id) lets two racers both win — what the store's compare-and-set prevents", async () => {
    const instances = instancesOn(new VirtualClock());
    const [first] = instances;
    if (first === undefined) throw new Error("six instances");
    const lease = await leaseOf(first, "naive");
    const key = keyOf(lease);
    await instances[0]?.calls.saveIfAbsent(key, intentOf(key));
    const naiveMove = async (owner: string): Promise<boolean> => {
      const read = await onSchema(
        database.url(),
        "SELECT id, attempt_owner FROM agboss_outbound_calls WHERE scope_key = $1",
        [key.scopeKey],
      );
      const [row] = read.rows as { id: string; attempt_owner: string }[];
      if (row?.attempt_owner !== "owner-1") return false;
      await onSchema(database.url(), "SELECT pg_sleep(0.2)");
      await onSchema(
        database.url(),
        "UPDATE agboss_outbound_calls SET attempt_owner = $1 WHERE id = $2",
        [owner, row.id],
      );
      return true;
    };

    const naive = await Promise.all([naiveMove("naive-a"), naiveMove("naive-b")]);
    await onSchema(database.url(), "UPDATE agboss_outbound_calls SET attempt_owner = 'owner-1'");
    const stored = await Promise.all(
      instances.map((stores, index) =>
        stores.calls.markPending(key, PENDING, { attempt: 2, attemptOwner: `o-${String(index)}` }),
      ),
    );

    expect(naive).toEqual([true, true]);
    expect(stored.filter(Boolean)).toHaveLength(1);
  });
});

describe("PostgresOutboundCallRepository: edges", () => {
  it("#521: a NUL character in the step's idempotency key and the attempt owner: found, matched and moved", async () => {
    const stores = instanceOn(new VirtualClock(), 0);
    const lease = await leaseOf(stores, "nul");
    const key = keyOf(lease, { idempotencyKey: "nul:\u0000step:1" });
    await stores.calls.saveIfAbsent(key, intentOf(key, "owner\u0000a"));

    const isMoved = await stores.calls.markPending(
      key,
      { ...PENDING, attemptOwner: "owner\u0000a" },
      { attempt: 2, attemptOwner: "owner\u0000b" },
    );

    expect(isMoved).toBe(true);
    expect(await stores.calls.markCompleted(key, "owner\u0000b", '"done"')).toBe(true);
    expect(await stores.calls.findByKey(key)).toMatchObject({
      idempotencyKey: "nul:\u0000step:1:charge",
      attemptOwner: "owner\u0000b",
      status: OutboundCallStatus.Completed,
    });
  });

  it("a pool of one: every fenced method runs its checks and its statement on one connection", async () => {
    const stores = instanceOn(new VirtualClock(), 0, 1);
    const lease = await leaseOf(stores, "pool-one");
    const key = keyOf(lease);

    await stores.calls.saveIfAbsent(key, intentOf(key));
    const calls = await Promise.all([
      stores.calls.findByKey(key),
      stores.calls.markFailed(key, "owner-1", { name: "E", code: "E", message: "no" }),
      stores.calls.leaseStateOf({ tenantId: "default", leaseExecutionId: "pool-one", token: 1 }),
    ]);

    expect(calls[2]).toBe(OutboundCallLeaseState.Live);
    expect((await stores.calls.findByKey(key))?.status).toBe(OutboundCallStatus.Failed);
  });

  it("a lease closed by leaseStateOf stays superseded when its holder releases it late: the next take still names it", async () => {
    const clock = new VirtualClock();
    const [holder, other] = [instanceOn(clock, 0), instanceOn(clock, 1)];
    const lease = await leaseOf(holder, "late-release", seconds(30));
    await clock.advance(seconds(31));
    const state = { tenantId: "default", leaseExecutionId: "late-release", token: 1 };
    expect(await other.calls.leaseStateOf(state)).toBe(OutboundCallLeaseState.Superseded);

    await holder.leases.release(lease);
    const taken = await leaseOf(other, "late-release");

    expect(taken.takenOverFrom).toEqual({ holderInstanceId: "instance-0", leaseEpoch: 1 });
    expect(await leaseOf(holder, "late-release").catch(() => "held")).toBe("held");
    expect(await other.calls.leaseStateOf({ ...state, token: 2 })).toBe(
      OutboundCallLeaseState.Live,
    );
  });

  it("a stored row that is not a record is refused when read, never half-read", async () => {
    const stores = instanceOn(new VirtualClock(), 0);
    const lease = await leaseOf(stores, "corrupt");
    const key = keyOf(lease);
    await stores.calls.saveIfAbsent(key, intentOf(key));
    await onSchema(
      database.url(),
      `UPDATE agboss_outbound_calls SET record = record - 'attempt' WHERE root_execution_id = 'corrupt'`,
    );

    await expect(stores.calls.findByKey(key)).rejects.toThrow(/attempt/);
    await expect(
      stores.calls.findAllByTenantIdAndRootExecutionId("default", "corrupt"),
    ).rejects.toThrow(/attempt/);
  });

  it("a lease row of the key missing: refused, ExecutionFencedError with no observed token", async () => {
    const stores = instanceOn(new VirtualClock(), 0);
    const key = keyOf({
      tenantId: "default",
      rootExecutionId: "never-taken",
      holderInstanceId: "instance-0",
      leaseEpoch: 1,
      expiresAt: new Date(),
    });

    const refused = await stores.calls
      .saveIfAbsent(key, intentOf(key))
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ExecutionFencedError);
    expect(refused).toMatchObject({ token: 1, observedToken: undefined });
  });

  it("an unreachable database rejects every method", async () => {
    const connection = connectionTo("postgres://postgres:pw@127.0.0.1:1/postgres");
    const calls = new PostgresOutboundCallRepository(connection, new VirtualClock());
    const key = keyOf({
      tenantId: "default",
      rootExecutionId: "x",
      holderInstanceId: "i",
      leaseEpoch: 1,
      expiresAt: new Date(),
    });

    await expect(calls.ping()).rejects.toThrow();
    await expect(calls.findByKey(key)).rejects.toThrow();
    await expect(
      calls.findAllByTenantIdAndStatus("default", OutboundCallStatus.Pending),
    ).rejects.toThrow();
    await expect(calls.deleteByEndedAtBefore(new Date())).rejects.toThrow();
    await expect(
      calls.leaseStateOf({ tenantId: "default", leaseExecutionId: "x", token: 1 }),
    ).rejects.toThrow();
  });
});
