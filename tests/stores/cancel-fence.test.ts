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

describe("agbossjs/agboss#909, #1117: the cancel's fence is the root lease row's lock", () => {
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

  it("a fencing transaction that starts while a cancel holds the root's row waits for it and reads the committed mark", async () => {
    const root = "root-cancel-2";
    const { effects, leases } = storesOn(connectionTo(database.url()));
    const lease = await leases.acquire("default", root, hours(1));
    // a cancel in progress: the root's lease row locked, the mark not yet written
    const client = new pg.Client({ connectionString: database.url() });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT 1 FROM agboss_execution_leases WHERE tenant_id = 'default' AND root_execution_id = $1 FOR UPDATE",
        [root],
      );
      const write = effects
        .runOnce(keyOf(root, lease?.token ?? 0), () => ({ receipt: "r1" }))
        .catch((error: unknown) => error);

      // the write cannot pass its lease check: it waits for the row's lock
      expect(await settledWithin(write, 400)).toBe(false);
      await client.query(
        "UPDATE agboss_execution_leases SET cancel_requested_at = now() WHERE tenant_id = 'default' AND root_execution_id = $1",
        [root],
      );
      await client.query("COMMIT");

      expect(await write).toBeInstanceOf(ExecutionCancelFencedError);
    } finally {
      await client.end();
    }
  });

  it("a child's open fencing transaction holds its root's row although the root never had one: a cancel of the root waits for it", async () => {
    const { effects, leases } = storesOn(connectionTo(database.url()));
    const other = storesOn(connectionTo(database.url()));
    const child = await leases.acquire("default", "child-race", hours(1));
    const key = effectKeyForTesting({
      scopeKey: "default:child-race",
      tenantId: "default",
      leaseExecutionId: "child-race",
      rootExecutionId: "root-never-held",
      token: child?.token ?? 0,
      idempotencyKey: "child-race:charge-action:1:charge",
      name: "charge",
    });
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let isInside = (): void => undefined;
    const inside = new Promise<void>((resolve) => {
      isInside = resolve;
    });

    const write = effects.runOnce(key, async () => {
      isInside();
      await opened;
      return { receipt: "r1" };
    });
    await inside;
    const cancel = other.leases.requestCancel({
      tenantId: "default",
      rootExecutionId: "root-never-held",
    });

    // the root's seed row is the child's to share until its transaction ends
    expect(await settledWithin(cancel, 400)).toBe(false);
    open();
    expect((await write).status).toBe(FencedEffectStatus.Ran);
    await cancel;
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

describe("agbossjs/agboss#1117: the cancel's mark is permanent", () => {
  /** The roots of those named whose lease row carries a mark. */
  async function marksOf(roots: readonly string[]): Promise<readonly string[]> {
    const client = new pg.Client({ connectionString: database.url() });
    await client.connect();
    try {
      const { rows } = await client.query(
        "SELECT root_execution_id FROM agboss_execution_leases WHERE cancel_requested_at IS NOT NULL AND root_execution_id = ANY($1) ORDER BY 1",
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
    "%s lifts no mark — of a retired tree, a live one, a tree never acquired — at any age",
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

      expect(await marksOf([over, alive, never])).toEqual([alive, never, over].sort());
    },
  );

  it("a cancel before the first acquire writes a seed row (token 0, released): the first acquire is token 1, no takeover, and the mark stays", async () => {
    const { leases } = storesOn(connectionTo(database.url()));
    const root = "root-seed";

    await leases.requestCancel({ tenantId: "default", rootExecutionId: root });
    const taken = await leases.acquire("default", root, hours(1));

    expect(taken).toMatchObject({ token: 1 });
    expect(taken?.takenOverFrom).toBeUndefined();
    expect(await marksOf([root])).toEqual([root]);
  });

  it("a child's check seeds its root's row when there is none, and a cancel of that root is then refused for the child", async () => {
    const { effects, leases } = storesOn(connectionTo(database.url()));
    const child = await leases.acquire("default", "child-1", hours(1));
    const keyFor = (name: string) =>
      effectKeyForTesting({
        scopeKey: "default:child-1",
        tenantId: "default",
        leaseExecutionId: "child-1",
        rootExecutionId: "root-of-child",
        token: child?.token ?? 0,
        idempotencyKey: `child-1:charge-action:1:${name}`,
        name,
      });

    expect((await effects.runOnce(keyFor("charge"), () => ({ receipt: "r1" }))).status).toBe(
      FencedEffectStatus.Ran,
    );
    await leases.requestCancel({ tenantId: "default", rootExecutionId: "root-of-child" });
    const later = await effects
      .runOnce(keyFor("later"), () => ({ receipt: "r2" }))
      .catch((error: unknown) => error);

    expect(later).toBeInstanceOf(ExecutionCancelFencedError);
  });
});
