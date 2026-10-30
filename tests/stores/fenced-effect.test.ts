import { ExecutionFencedError, FencedEffectSettings, FencedEffectStatus } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { hours } from "@agboss/core/units";
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
    effects: new PostgresFencedEffectRepository(connection, clock, new FencedEffectSettings()),
    leases: new PostgresExecutionLeaseRepository(connection, clock, new TestApplicationContext({})),
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
