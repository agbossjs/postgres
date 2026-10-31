/**
 * agbossjs/agboss#533 AC4 on PostgreSQL, across processes: two application instances, each its own
 * `node` process, whose clocks disagree — B's `Date` (and its monotonic clock, for a drift) stubbed
 * ahead or behind the host's by half a lease, a lease and ten leases, or running 1 % fast or slow
 * (`tests/fixtures/skewed-date.ts`). The database's clock decides every lease's expiry
 * (`clock_timestamp()`), so:
 * - while A is alive and renewing, with its charge in flight, B's recovery sweep never takes A's
 *   lease — at most one live holder, no reconcile, A finishes its own charge, one request reaches
 *   the gateway;
 * - once A is frozen, B — even ten leases behind — takes the tree over on time and reconciles,
 *   one charge.
 *
 * Before agbossjs/agboss#533 the store compared `expires_at` with the caller's clock: B a lease or
 * more ahead took A's live lease at its first sweep (A's run then failed with a lost lease), and B
 * behind took a frozen A's tree only once its own clock passed the expiry — ten leases late.
 */
import { ExecutionLeaseEventKind, type ExecutionLeaseEventRecord } from "@agboss/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { eventsOf, launch, type Instance } from "./instances.js";

const database = testDatabase();

/** The framework's lease (30 s). */
const LEASE = 30_000;

beforeAll(async () => {
  await onSchema(
    database.url(),
    `CREATE TABLE test_gateway_attempts (seq bigserial PRIMARY KEY, idempotency_key text NOT NULL,
       order_id text NOT NULL, instance_id text NOT NULL);
     CREATE TABLE test_gateway_charges (idempotency_key text PRIMARY KEY, order_id text NOT NULL,
       instance_id text NOT NULL)`,
  );
});

beforeEach(async () => {
  await onSchema(
    database.url(),
    "TRUNCATE test_gateway_attempts, test_gateway_charges, agboss_outbound_calls",
  );
});

/** How many requests reached the gateway. */
async function attempts(): Promise<number> {
  const { rows } = await onSchema(database.url(), "SELECT 1 FROM test_gateway_attempts");
  return rows.length;
}

const takeoversOf = async (instance: Instance, rootExecutionId: string) =>
  (
    (await instance.send("lease-events", {
      tenantId: "default",
      rootExecutionId,
    })) as ExecutionLeaseEventRecord[]
  ).filter((row) => row.kind === ExecutionLeaseEventKind.Takeover);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A charges `name` and waits at its gate, the charge in flight; the tree's root. */
async function charging(a: Instance, name: string) {
  const run = a.send("execute", { workflow: "charge", input: { name } }).then(
    (output) => ({ output }),
    (error: unknown) => ({ error }),
  );
  const started = await a.next((event) => event.event === "charging" && event.name === name);
  return { run, root: String(started.rootExecutionId) };
}

const SKEWS: readonly (readonly [string, { offsetMs?: number; drift?: number }])[] = [
  ["half a lease ahead", { offsetMs: LEASE / 2 }],
  ["half a lease behind", { offsetMs: -LEASE / 2 }],
  ["a lease ahead", { offsetMs: LEASE }],
  ["a lease behind", { offsetMs: -LEASE }],
  ["10 leases ahead", { offsetMs: 10 * LEASE }],
  ["10 leases behind", { offsetMs: -10 * LEASE }],
  ["1 % fast", { drift: 0.01 }],
  ["1 % slow", { drift: -0.01 }],
];

describe("agbossjs/agboss#533 AC4: instances whose clocks disagree, on one PostgreSQL", () => {
  it.each(SKEWS)(
    "B's clock %s: B never takes the lease A holds and renews — A finishes its charge, one request reaches the gateway",
    async (label, clock) => {
      const a = await launch(database.url());
      const name = `order-${label.replaceAll(" ", "-")}`;
      const { run, root } = await charging(a, name);
      const b = await launch(database.url(), { gate: "open", clock });
      // B's sweep at its start (and a renewal of A's lease) pass while A's charge is in flight
      await sleep(6_000);

      await a.send("open");
      const outcome = await run;

      expect(outcome).toHaveProperty("output");
      expect(eventsOf(b, "reconciling")).toEqual([]);
      expect(await takeoversOf(a, root)).toEqual([]);
      expect(await attempts()).toBe(1);
      await b.kill();
      await a.kill();
    },
    60_000,
  );

  it.each([
    ["a lease behind", -LEASE],
    ["10 leases behind", -10 * LEASE],
  ] as const)(
    "B's clock %s: A frozen mid-charge, B takes the tree over on the database's time and reconciles — one charge",
    async (_, offsetMs) => {
      const a = await launch(database.url());
      const { root } = await charging(a, "order-frozen");
      a.freeze();
      const b = await launch(database.url(), { gate: "open", clock: { offsetMs } });

      // the lease ends 30 s after A's last renewal; B's sweep comes every 30 s: by 75 s at most
      const end = await b.next(
        (event) => event.event === "end" && event.executionId === root,
        75_000,
      );

      expect(end).toMatchObject({ rootExecutionId: root, finish: "charge-workflow-finish" });
      expect(eventsOf(b, "reconciling")).toHaveLength(1);
      expect(await takeoversOf(b, root)).toEqual([
        expect.objectContaining({ previousHolderInstanceId: a.instanceId }),
      ]);
      expect(await attempts()).toBe(1);
      await a.kill();
      await b.kill();
    },
    120_000,
  );
});
