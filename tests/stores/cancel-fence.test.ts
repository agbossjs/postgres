import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import {
  ExecutionCancelFencedError,
  FencedEffectSettings,
  FencedEffectStatus,
  StoreClock,
  StoreTimeSource,
} from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { hours } from "@agboss/core/units";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
  type PostgresConnection,
} from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#909 on PostgreSQL: the cancel's fence is a pair of advisory locks of the tree
 * (namespace 909). A cancel waits for the tree's open fencing transaction — the write lands first —,
 * and a fencing transaction that starts while a cancel holds the lock waits for it and reads the
 * committed mark: refused. Never the write landing after the cancel answered.
 */
const database = testDatabase();

function storesOn(connection: PostgresConnection) {
  const clock = new StoreClock(StoreTimeSource.Test, new VirtualClock());
  return {
    effects: new PostgresFencedEffectRepository(connection, clock, new FencedEffectSettings()),
    leases: new PostgresExecutionLeaseRepository(connection, clock, new TestApplicationContext({})),
  };
}

const keyOf = (root: string, token: number, name = "charge") =>
  effectKeyForTesting({
    scopeKey: `default:${root}`,
    tenantId: "default",
    leaseExecutionId: root,
    token,
    idempotencyKey: `${root}:charge-action:1:${name}`,
    name,
  });

/** Whether `promise` settled within `ms` of real time. */
const settledWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, ms);
    }),
  ]);

describe("agbossjs/agboss#909: the cancel's advisory locks", () => {
  it("a cancel waits for the tree's open fencing transaction: the write lands first, the next is refused", async () => {
    const root = "root-cancel-1";
    const { effects, leases } = storesOn(connectionTo(database.url()));
    const other = storesOn(connectionTo(database.url()));
    const lease = await leases.acquire("default", root, hours(1));
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let isInside = (): void => undefined;
    const inside = new Promise<void>((resolve) => {
      isInside = resolve;
    });

    const write = effects.runOnce(keyOf(root, lease?.token ?? 0), async () => {
      isInside();
      await opened;
      return { receipt: "r1" };
    });
    await inside;
    const cancel = other.leases.requestCancel({ tenantId: "default", rootExecutionId: root });

    // the transaction is open: the cancel is still waiting for the tree's lock
    expect(await settledWithin(cancel, 400)).toBe(false);
    open();
    const written = await write;
    await cancel;

    expect(written.status).toBe(FencedEffectStatus.Ran);
    const later = await effects
      .runOnce(keyOf(root, lease?.token ?? 0, "later"), () => ({ receipt: "r2" }))
      .catch((error: unknown) => error);
    expect(later).toBeInstanceOf(ExecutionCancelFencedError);
  });

  it("a fencing transaction that starts while a cancel holds the tree's lock waits for it and reads the committed mark", async () => {
    const root = "root-cancel-2";
    const { effects, leases } = storesOn(connectionTo(database.url()));
    const lease = await leases.acquire("default", root, hours(1));
    // a cancel in progress: the exclusive lock of the tree's identity taken, the mark not yet written
    const client = new pg.Client({ connectionString: database.url() });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 909))", [
        JSON.stringify(["default", root]),
      ]);
      const write = effects
        .runOnce(keyOf(root, lease?.token ?? 0), () => ({ receipt: "r1" }))
        .catch((error: unknown) => error);

      // the write cannot pass its cancel check: it waits for the lock
      expect(await settledWithin(write, 400)).toBe(false);
      await client.query(
        "INSERT INTO agboss_execution_cancel_requests VALUES ('default', $1, now())",
        [root],
      );
      await client.query("COMMIT");

      expect(await write).toBeInstanceOf(ExecutionCancelFencedError);
    } finally {
      await client.end();
    }
  });

  it("a cancel of one tree never waits for another tree's open transaction", async () => {
    const { effects, leases } = storesOn(connectionTo(database.url()));
    const lease = await leases.acquire("default", "root-cancel-3", hours(1));
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let isInside = (): void => undefined;
    const inside = new Promise<void>((resolve) => {
      isInside = resolve;
    });
    const write = effects.runOnce(keyOf("root-cancel-3", lease?.token ?? 0), async () => {
      isInside();
      await opened;
      return { receipt: "r1" };
    });
    await inside;

    const cancel = leases.requestCancel({ tenantId: "default", rootExecutionId: "root-cancel-4" });

    expect(await settledWithin(cancel, 2000)).toBe(true);
    open();
    expect((await write).status).toBe(FencedEffectStatus.Ran);
  });
});

describe("agbossjs/agboss#909: the retention and the cancel's mark", () => {
  /** The roots that still have a cancel mark, of those named. */
  async function marksOf(roots: readonly string[]): Promise<readonly string[]> {
    const client = new pg.Client({ connectionString: database.url() });
    await client.connect();
    try {
      const { rows } = await client.query(
        "SELECT root_execution_id FROM agboss_execution_cancel_requests WHERE root_execution_id = ANY($1) ORDER BY 1",
        [roots],
      );
      return rows.map((row: { root_execution_id: string }) => row.root_execution_id);
    } finally {
      await client.end();
    }
  }

  it.each([
    ["the fenced effects' sweep", "effects"],
    ["the outbound calls' sweep", "calls"],
  ] as const)(
    "%s lifts the mark of a tree whose lease finished, never of a tree not over, at any age",
    async (_, sweeper) => {
      const connection = connectionTo(database.url());
      const { effects, leases } = storesOn(connection);
      const calls = new PostgresOutboundCallRepository(
        connection,
        new StoreClock(StoreTimeSource.Test, new VirtualClock()),
      );
      const over = `root-over-${sweeper}`;
      const alive = `root-alive-${sweeper}`;
      const never = `root-never-${sweeper}`;
      const finished = await leases.acquire("default", over, hours(1));
      await leases.acquire("default", alive, hours(1));
      for (const root of [over, alive, never])
        await leases.requestCancel({ tenantId: "default", rootExecutionId: root });
      if (finished !== undefined) await leases.retire(finished);
      const farFuture = new Date(Date.now() + hours(24 * 365));

      if (sweeper === "effects") await effects.deleteByStoredAtBefore(farFuture);
      else await calls.deleteByEndedAtBefore(farFuture);

      expect(await marksOf([over, alive, never])).toEqual([alive, never].sort());
    },
  );
});
