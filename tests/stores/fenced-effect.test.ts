import {
  ExecutionFencedError,
  FencedEffectSettings,
  FencedEffectStatus,
  IdempotencyKeyConflictError,
  InvalidFencedEffectNameError,
  TestStoreClock,
} from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { hours, seconds } from "@agboss/core/units";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
  type PostgresConnection,
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
      new TestStoreClock(clock),
      new FencedEffectSettings(),
    ),
    leases: new PostgresExecutionLeaseRepository(
      connection,
      new TestStoreClock(clock),
      new TestApplicationContext({}),
    ),
  };
}

const keyOf = (rootExecutionId: string, token: number) => ({
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

    const outcome = await effects.saveResultIfAbsent(
      keyOf("root-pool-1", lease?.leaseEpoch ?? 0),
      async (client) => {
        await client.query("INSERT INTO charges VALUES ('c-1', 10)");
        const { rows } = await client.query<{ total: number }>(
          "SELECT sum(amount)::integer AS total FROM charges",
        );
        return { total: rows[0]?.total ?? 0 };
      },
    );

    expect(outcome).toEqual({ status: FencedEffectStatus.Ran, result: { total: 10 }, token: 1 });
  });

  it("a connection lost inside the effect rejects it, nothing written, and the next call runs", async () => {
    const connection = connectionTo(database.url(), 1);
    const { effects, leases } = storesOn(connection);
    const lease = await leases.acquire("default", "root-lost", hours(1));
    const key = keyOf("root-lost", lease?.leaseEpoch ?? 0);

    const lost = effects.saveResultIfAbsent(key, async (client) => {
      await client.query("INSERT INTO charges VALUES ('c-lost', 5)");
      await client.query("SELECT pg_terminate_backend(pg_backend_pid())");
      return { charged: true };
    });

    await expect(lost).rejects.toThrow();
    const { rows } = await onSchema(database.url(), "SELECT id FROM charges WHERE id = 'c-lost'");
    expect(rows).toEqual([]);
    const again = await effects.saveResultIfAbsent(key, async (client) => {
      await client.query("INSERT INTO charges VALUES ('c-lost', 5)");
      return { charged: true };
    });
    expect(again.status).toBe(FencedEffectStatus.Ran);
  });

  it("an unreachable database rejects the effect: the step fails, nothing is written", async () => {
    const { effects } = storesOn(connectionTo("postgres://postgres:pw@127.0.0.1:1/postgres"));

    const call = effects.saveResultIfAbsent(keyOf("root-down", 1), () => ({ charged: true }));

    await expect(call).rejects.toThrow();
    await expect(call).rejects.not.toBeInstanceOf(ExecutionFencedError);
  });

  it("is listed with the lease store whose leases it reads", () => {
    expect(PostgresFencedEffectRepository.leaseRepository).toBe(PostgresExecutionLeaseRepository);
  });
});

/** One business key's effect from the lease of `root` at `token`, with `fingerprint`. */
const businessKeyOf = (root: string, token: number, fingerprint = "f", visitNumber = 1) => ({
  ...keyOf(root, token),
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
          effects.saveResultIfAbsent(
            { ...businessKeyOf(root, 1), businessKey: `order:race-${String(round)}` },
            async (client) => {
              runs += 1;
              await client.query("INSERT INTO charges VALUES ($1, 1)", [`race-${String(round)}`]);
              return { by: root };
            },
          ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === FencedEffectStatus.Ran)).toHaveLength(
        1,
      );
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
    await effects.saveResultIfAbsent(businessKeyOf("bk-1", 1), () => ({ receipt: "r1" }));

    const other = await effects.saveResultIfAbsent(businessKeyOf("bk-2", 1), () => ({
      receipt: "r2",
    }));
    const same = await effects.saveResultIfAbsent(businessKeyOf("bk-1", 1), () => ({
      receipt: "r3",
    }));
    const conflict = await effects
      .saveResultIfAbsent(businessKeyOf("bk-2", 1, "g"), () => ({ receipt: "r4" }))
      .catch((error: unknown) => error);

    expect(other).toEqual({
      status: FencedEffectStatus.Replayed,
      result: { receipt: "r1" },
      token: 1,
      replayedFrom: { executionId: "bk-1", nodeId: "charge-action", visitNumber: 1 },
    });
    expect(same).toEqual({
      status: FencedEffectStatus.Replayed,
      result: { receipt: "r1" },
      token: 1,
    });
    expect(conflict).toBeInstanceOf(IdempotencyKeyConflictError);
    expect(JSON.stringify(conflict) + String(conflict)).not.toContain("order:42");
  });

  it("a key with no step of its own (built by hand) replays without replayedFrom; one without a fingerprint stores none", async () => {
    const { effects, leases } = storesOn(connectionTo(database.url()));
    await leases.acquire("default", "bk-bare", hours(1));
    const bare = { ...keyOf("bk-bare", 1), businessKey: "order:bare" };

    await effects.saveResultIfAbsent(bare, () => ({ receipt: "r1" }));
    const again = await effects.saveResultIfAbsent(
      { ...bare, origin: { executionId: "x", nodeId: "n", visitNumber: 1 } },
      () => ({ receipt: "r2" }),
    );

    expect(again).toEqual({
      status: FencedEffectStatus.Replayed,
      result: { receipt: "r1" },
      token: 1,
    });
    const { rows } = await onSchema(
      database.url(),
      "SELECT fingerprint, origin FROM agboss_fenced_effect_business_results WHERE business_key = 'order:bare'",
    );
    expect(rows).toEqual([{ fingerprint: null, origin: null }]);
  });

  it("an invalid name built by hand is refused before any statement: InvalidFencedEffectNameError", async () => {
    const { effects, leases } = storesOn(connectionTo(database.url()));
    await leases.acquire("default", "bad-name", hours(1));

    for (const name of ["charge:twice", "x".repeat(101), "-lead"])
      await expect(
        effects.saveResultIfAbsent({ ...keyOf("bad-name", 1), name }, () => ({ ran: true })),
      ).rejects.toBeInstanceOf(InvalidFencedEffectNameError);
  });

  it("the sweep removes a business key's result stored before the cutoff, and keeps a later one", async () => {
    const clock = new VirtualClock();
    const { effects, leases } = storesOn(connectionTo(database.url()), clock);
    await leases.acquire("default", "sweep", hours(10));
    await effects.saveResultIfAbsent(
      { ...businessKeyOf("sweep", 1), businessKey: "sweep:old" },
      () => 1,
    );
    await clock.advance(seconds(10));
    await effects.saveResultIfAbsent(
      { ...businessKeyOf("sweep", 1), businessKey: "sweep:new" },
      () => 2,
    );

    await effects.deleteByStoredAtBefore(new Date(clock.now().getTime() - seconds(5)));

    const { rows } = await onSchema(
      database.url(),
      "SELECT business_key FROM agboss_fenced_effect_business_results WHERE business_key LIKE 'sweep:%'",
    );
    expect(rows).toEqual([{ business_key: "sweep:new" }]);
  });
});
