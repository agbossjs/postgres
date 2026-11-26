import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import {
  StoreClock,
  StoreTimeSource,
  ExecutionError,
  IdempotencyError,
  IdempotencyRunStatus,
} from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { hours, seconds } from "@agboss/core/units";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
  type PostgresConnection,
  requirePostgresTransaction,
} from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { TestApplicationContext } from "../support/application-context.js";
import { connectionTo } from "../support/stores.js";

/** The #500 edges on PostgreSQL: a pool of one, a connection lost inside the effect. */
const database = testDatabase();

beforeAll(async () => {
  await onSchema(database.url(), "CREATE TABLE charges (id text PRIMARY KEY, amount integer)");
});

function storesOn(connection: PostgresConnection, clock = new VirtualClock()) {
  return {
    effects: new PostgresFencedEffectRepository(
      connection,
      new StoreClock(StoreTimeSource.Test, clock),
    ),
    leases: new PostgresExecutionLeaseRepository(
      connection,
      new StoreClock(StoreTimeSource.Test, clock),
      new TestApplicationContext(),
    ),
  };
}

const keyOf = (rootExecutionId: string, token: number) =>
  effectKeyForTesting({
    scopeKey: `default:${rootExecutionId}`,
    tenantId: "default",
    leaseExecutionId: rootExecutionId,
    token,
    idempotencyKey: `${rootExecutionId}:charge-action:1`,
    name: "charge",
  });

describe("PostgresFencedEffectRepository", () => {
  it("a pool of one: the work's awaited statements run on the transaction's connection, no deadlock", async () => {
    const { effects, leases } = storesOn(connectionTo(database.url(), 1));
    const lease = await leases.acquire("default", "root-pool-1", hours(1));

    const outcome = await effects.runOnce(keyOf("root-pool-1", lease?.token ?? 0), async () => {
      const client = requirePostgresTransaction();
      await client.query("INSERT INTO charges VALUES ('c-1', 10)");
      const { rows } = await client.query<{ total: number }>(
        "SELECT sum(amount)::integer AS total FROM charges",
      );
      return { total: rows[0]?.total ?? 0 };
    });

    expect(outcome).toEqual({ status: IdempotencyRunStatus.Ran, result: { total: 10 }, token: 1 });
  });

  it("a connection lost inside the effect rejects it, nothing written, and the next call runs", async () => {
    const connection = connectionTo(database.url(), 1);
    const { effects, leases } = storesOn(connection);
    const lease = await leases.acquire("default", "root-lost", hours(1));
    const key = keyOf("root-lost", lease?.token ?? 0);

    const lost = effects.runOnce(key, async () => {
      const client = requirePostgresTransaction();
      await client.query("INSERT INTO charges VALUES ('c-lost', 5)");
      await client.query("SELECT pg_terminate_backend(pg_backend_pid())");
      return { charged: true };
    });

    await expect(lost).rejects.toThrow();
    const { rows } = await onSchema(database.url(), "SELECT id FROM charges WHERE id = 'c-lost'");
    expect(rows).toEqual([]);
    const again = await effects.runOnce(key, async () => {
      await requirePostgresTransaction().query("INSERT INTO charges VALUES ('c-lost', 5)");
      return { charged: true };
    });
    expect(again.status).toBe(IdempotencyRunStatus.Ran);
  });

  it("an unreachable database rejects the effect: the step fails, nothing is written", async () => {
    const { effects } = storesOn(connectionTo("postgres://postgres:pw@127.0.0.1:1/postgres"));

    const call = effects.runOnce(keyOf("root-down", 1), () => ({ charged: true }));

    await expect(call).rejects.toThrow();
    await expect(call).rejects.not.toBeInstanceOf(ExecutionError.Fenced);
  });

  it("is listed with the lease store whose leases it reads", () => {
    expect(PostgresFencedEffectRepository.store.backend).toBe(
      PostgresExecutionLeaseRepository.store.backend,
    );
  });
});

/** One business key's effect from the lease of `root` at `token`, with `fingerprint`. */
const businessKeyOf = (root: string, token: number, fingerprint = "f", visitNumber = 1) =>
  effectKeyForTesting(keyOf(root, token), {
    businessKey: "order:42",
    fingerprint,
    origin: { executionId: root, nodeId: "charge-action", visitNumber },
  });

describe("PostgresFencedEffectRepository: business keys (agbossjs/agboss#508)", () => {
  it("six executions on six instances racing on one business key, round after round: one Ran, the work once", async () => {
    const instances = Array.from({ length: 6 }, () =>
      storesOn(connectionTo(database.url(), 2), new VirtualClock()),
    ).map((stores, index) => ({ ...stores, root: `race-${String(index)}` }));
    for (const { leases, root } of instances) await leases.acquire("default", root, hours(1));
    let runs = 0;

    for (let round = 0; round < 15; round += 1) {
      const outcomes = await Promise.all(
        instances.map(({ effects, root }) =>
          effects.runOnce(
            effectKeyForTesting(businessKeyOf(root, 1), {
              businessKey: `order:race-${String(round)}`,
            }),
            async () => {
              runs += 1;
              await requirePostgresTransaction().query("INSERT INTO charges VALUES ($1, 1)", [
                `race-${String(round)}`,
              ]);
              return { by: root };
            },
          ),
        ),
      );

      expect(
        outcomes.filter((outcome) => outcome.status === IdempotencyRunStatus.Ran),
      ).toHaveLength(1);
      const results = new Set(outcomes.map((outcome) => JSON.stringify(outcome.result)));
      expect(results.size).toBe(1);
    }
    expect(runs).toBe(15);
  });

  it("a replay names the step that wrote it; the same step again names none; another fingerprint is a conflict that holds no key", async () => {
    const clock = new VirtualClock();
    const { effects, leases } = storesOn(connectionTo(database.url()), clock);
    await leases.acquire("default", "bk-1", hours(1));
    await leases.acquire("default", "bk-2", hours(1));
    await effects.runOnce(businessKeyOf("bk-1", 1), () => ({ receipt: "r1" }));

    const other = await effects.runOnce(businessKeyOf("bk-2", 1), () => ({
      receipt: "r2",
    }));
    const same = await effects.runOnce(businessKeyOf("bk-1", 1), () => ({
      receipt: "r3",
    }));
    const conflict = await effects
      .runOnce(businessKeyOf("bk-2", 1, "g"), () => ({ receipt: "r4" }))
      .catch((error: unknown) => error);

    expect(other).toEqual({
      status: IdempotencyRunStatus.Replayed,
      result: { receipt: "r1" },
      token: 1,
      replayedFrom: { executionId: "bk-1", nodeId: "charge-action", visitNumber: 1 },
    });
    expect(same).toEqual({
      status: IdempotencyRunStatus.Replayed,
      result: { receipt: "r1" },
      token: 1,
    });
    expect(conflict).toBeInstanceOf(IdempotencyError.KeyConflict);
    expect(JSON.stringify(conflict) + String(conflict)).not.toContain("order:42");
  });

  it("a key with no step of its own (built by hand) replays without replayedFrom; one under FingerprintPolicy.None stores no fingerprint", async () => {
    const { effects, leases } = storesOn(connectionTo(database.url()));
    await leases.acquire("default", "bk-bare", hours(1));
    const bare = effectKeyForTesting(keyOf("bk-bare", 1), {
      businessKey: "order:bare",
      withoutFingerprint: true,
    });

    await effects.runOnce(bare, () => ({ receipt: "r1" }));
    const again = await effects.runOnce(
      effectKeyForTesting(bare, { origin: { executionId: "x", nodeId: "n", visitNumber: 1 } }),
      () => ({ receipt: "r2" }),
    );

    expect(again).toEqual({
      status: IdempotencyRunStatus.Replayed,
      result: { receipt: "r1" },
      token: 1,
    });
    const { rows } = await onSchema(
      database.url(),
      "SELECT fingerprint, origin FROM agboss_fenced_effect_business_results WHERE business_key = 'order:bare'",
    );
    expect(rows).toEqual([{ fingerprint: null, origin: null }]);
  });

  it("an invalid name built by hand is refused before any statement: IdempotencyError.InvalidName", async () => {
    const { effects, leases } = storesOn(connectionTo(database.url()));
    await leases.acquire("default", "bad-name", hours(1));

    for (const name of ["charge:twice", "x".repeat(101), "-lead"])
      await expect(
        effects.runOnce(effectKeyForTesting(keyOf("bad-name", 1), { name }), () => ({
          ran: true,
        })),
      ).rejects.toBeInstanceOf(IdempotencyError.InvalidName);
  });

  it("the sweep removes a business key's result whose expiry has come, and keeps a later one and one that never expires", async () => {
    const clock = new VirtualClock();
    const { effects, leases } = storesOn(connectionTo(database.url()), clock);
    await leases.acquire("default", "sweep", hours(10));
    const at = (offset: number) => new Date(clock.now().getTime() + offset);
    const expiring = (businessKey: string, expiresAt: Date | null) =>
      effectKeyForTesting(businessKeyOf("sweep", 1), { businessKey, expiresAt });
    await effects.runOnce(expiring("sweep:old", at(seconds(5))), () => 1);
    await effects.runOnce(expiring("sweep:new", at(seconds(50))), () => 2);
    await effects.runOnce(expiring("sweep:forever", null), () => 3);

    const removed = await effects.deleteExpired(at(seconds(10)));

    const { rows } = await onSchema(
      database.url(),
      "SELECT business_key FROM agboss_fenced_effect_business_results WHERE business_key LIKE 'sweep:%' ORDER BY 1",
    );
    expect(rows).toEqual([{ business_key: "sweep:forever" }, { business_key: "sweep:new" }]);
    // the result of `sweep:old` only: the scope's mark keeps the latest expiry, here never
    expect(removed).toBe(1);
  });

  // agbossjs/agboss#1367: mutants a Stryker Timeout used to hide (the shard's run outlasted its limit)
  it("#1367: a replay by the step that wrote the row has no replayedFrom at all, not an undefined one", async () => {
    const { effects, leases } = storesOn(connectionTo(database.url()));
    await leases.acquire("default", "bk-same", hours(1));
    await effects.runOnce(businessKeyOf("bk-same", 1), () => ({ receipt: "r1" }));

    const same = await effects.runOnce(businessKeyOf("bk-same", 1), () => ({ receipt: "r2" }));

    expect(same.status).toBe(IdempotencyRunStatus.Replayed);
    expect("replayedFrom" in same).toBe(false);
  });

  it("#1367: two business keys of one tenant do not wait on each other: the advisory lock is of the key's own identity", async () => {
    const slow = storesOn(connectionTo(database.url(), 2));
    const fast = storesOn(connectionTo(database.url(), 2));
    await slow.leases.acquire("default", "lock-slow", hours(1));
    await fast.leases.acquire("default", "lock-fast", hours(1));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = (): void => undefined;
    const slowHoldsItsLock = new Promise<void>((resolve) => {
      holding = resolve;
    });
    // the work runs inside the transaction, after the key's advisory lock was taken: when it runs, the slow key's lock is held
    const held = slow.effects.runOnce(
      effectKeyForTesting(businessKeyOf("lock-slow", 1), { businessKey: "order:slow" }),
      async () => {
        holding();
        await gate;
        return { by: "slow" };
      },
    );

    try {
      await slowHoldsItsLock;
      // the other key's effect finishes while the first one's work still holds its transaction; on one
      // shared lock it waits for a transaction that waits for `release`, and the command timeout ends it
      const other = await fast.effects.runOnce(
        effectKeyForTesting(businessKeyOf("lock-fast", 1), { businessKey: "order:fast" }),
        () => ({ by: "fast" }),
      );
      expect(other.status).toBe(IdempotencyRunStatus.Ran);
    } finally {
      release();
    }

    expect((await held).status).toBe(IdempotencyRunStatus.Ran);
  });

  it("#1367: the store's own entry refuses an invalid name, business key and missing fingerprint, whatever its base class checked", async () => {
    class Probe extends PostgresFencedEffectRepository {
      enter(key: Parameters<PostgresFencedEffectRepository["runOnce"]>[0]): Promise<unknown> {
        return this.runInTransaction(key, () => ({ ran: true }));
      }
    }
    const probe = new Probe(
      connectionTo(database.url()),
      new StoreClock(StoreTimeSource.Test, new VirtualClock()),
    );

    await expect(
      probe.enter(effectKeyForTesting(keyOf("entry", 1), { name: "charge:twice" })),
    ).rejects.toBeInstanceOf(IdempotencyError.InvalidName);
  });

  it("#1367: ping resolves on the connection's own ping", async () => {
    const { effects } = storesOn(connectionTo(database.url()));

    await expect(effects.ping()).resolves.toBeUndefined();
  });
});
