/**
 * agbossjs/agboss#505, #508 across processes — #482 AC1 extended with an outbound charge: two
 * application instances, each its own `node` process with its own pool, on one PostgreSQL and one
 * payment gateway (two tables of the schema, outside every store's transaction). A charges an order
 * and is frozen (SIGSTOP) mid-charge: the gateway charged it, the answer is not stored. B takes
 * over and reconciles with the gateway instead of charging again; A, thawed, sends its late answer
 * and is fenced. Exactly one request ever reaches the gateway. The real `Clock` and the core's
 * fixed 30 s lease; no real duration is asserted (agbossjs/agboss#523).
 */
import {
  ExecutionLeaseEventKind,
  OutboundCallEventOutcome,
  OutboundCallOutcomeStatus,
  OutboundCallStatus,
  type ExecutionLeaseEventRecord,
} from "@agboss/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { eventsOf, launch, type Instance } from "./instances.js";

const database = testDatabase();

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

/** What reached the gateway: every request, and the charges it made. */
async function gateway(): Promise<{ attempts: unknown[]; charges: unknown[] }> {
  const attempts = await onSchema(
    database.url(),
    "SELECT order_id, instance_id FROM test_gateway_attempts ORDER BY seq",
  );
  const charges = await onSchema(
    database.url(),
    "SELECT order_id, instance_id FROM test_gateway_charges",
  );
  return { attempts: attempts.rows, charges: charges.rows };
}

/** The intents of the schema, as their records. */
async function intents(): Promise<Record<string, unknown>[]> {
  const { rows } = await onSchema(database.url(), "SELECT record FROM agboss_outbound_calls");
  return rows.map((row: { record: Record<string, unknown> }) => row.record);
}

/** The lease log of a tree, read through `instance`. */
const logOf = async (instance: Instance, tenantId: string, rootExecutionId: string) =>
  (await instance.send("lease-events", {
    tenantId,
    rootExecutionId,
  })) as ExecutionLeaseEventRecord[];

/**
 * Until `offset` past the end of `root`'s lease (A frozen renews it no more): negative, before it.
 * The instances' clocks are the host's, as the test's.
 */
async function untilLeaseEnd(root: string, offset: number): Promise<void> {
  const { rows } = await onSchema(
    database.url(),
    "SELECT expires_at FROM agboss_execution_leases WHERE root_execution_id = $1",
    [root],
  );
  const [row] = rows as { expires_at: Date }[];
  if (row === undefined) throw new Error(`no lease of ${root}`);
  const left = row.expires_at.getTime() + offset - new Date().getTime();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, left)));
}

describe("an outbound charge across processes (#482 AC1 + agbossjs/agboss#505)", () => {
  it("A frozen mid-charge: B takes the tree over and reconciles, A's late answer is fenced — one charge", async () => {
    const a = await launch(database.url());
    const aRun = a.send("execute", { workflow: "charge", input: { name: "order-7" } }).then(
      (output) => ({ output }),
      (error: unknown) => ({ error }),
    );
    const charging = await a.next((event) => event.event === "charging");
    const root = String(charging.rootExecutionId);
    a.freeze();

    const b = await launch(database.url(), { gate: "open" });
    const end = await b.next(
      (event) => event.event === "end" && event.executionId === root,
      75_000,
    );

    expect(end).toMatchObject({ rootExecutionId: root, finish: "charge-workflow-finish" });
    expect(eventsOf(b, "charging")).toEqual([]);
    expect(eventsOf(b, "reconciling")).toHaveLength(1);
    expect(eventsOf(b, "charged")).toEqual([
      expect.objectContaining({ status: OutboundCallOutcomeStatus.Reconciled }),
    ]);
    const settled = await intents();
    expect(settled).toEqual([
      expect.objectContaining({ status: OutboundCallStatus.Completed, attempt: 1, token: 2 }),
    ]);

    // A, thawed, answers late: fenced — its run fails, nothing more is stored or charged
    a.thaw();
    await a.send("open");
    expect(await aRun).toHaveProperty("error");
    expect(eventsOf(a, "charged")).toEqual([]);
    expect(await intents()).toEqual(settled);
    expect(await gateway()).toEqual({
      attempts: [{ order_id: "order-7", instance_id: a.instanceId }],
      charges: [{ order_id: "order-7", instance_id: a.instanceId }],
    });
    const log = await logOf(b, String(end.tenantId), root);
    expect(log).toContainEqual(
      expect.objectContaining({
        kind: ExecutionLeaseEventKind.Takeover,
        previousHolderInstanceId: a.instanceId,
      }),
    );
    expect(log).toContainEqual(
      expect.objectContaining({
        kind: ExecutionLeaseEventKind.OutboundCall,
        outcome: OutboundCallEventOutcome.Reconciled,
        holderInstanceId: b.instanceId,
      }),
    );
  }, 150_000);

  it("#508: one order's business key in two trees — A frozen mid-charge in one, B charges it in another: B closes A's expired lease and reconciles; B's sweep then finishes A's tree from the stored charge — one charge", async () => {
    const a = await launch(database.url());
    const aRun = a.send("execute", { workflow: "order-charge", input: { name: "order-42" } }).then(
      (output) => ({ output }),
      (error: unknown) => ({ error }),
    );
    const charging = await a.next((event) => event.event === "charging");
    const first = String(charging.rootExecutionId);
    a.freeze();
    // B starts while A's lease is still held — its sweep at the start leaves the tree, the next
    // one comes a sweep period (30 s) later — and charges the order once A's lease has ended
    await untilLeaseEnd(first, -12_000);
    const b = await launch(database.url(), { gate: "open" });
    await untilLeaseEnd(first, 1_000);

    const second = (await b.send("execute", {
      workflow: "order-charge",
      input: { name: "order-42" },
    })) as { status: string; executionId: string };
    const end = await b.next(
      (event) => event.event === "end" && event.executionId === first,
      75_000,
    );

    expect(second.status).toBe("finished");
    expect(end).toMatchObject({ finish: "order-charge-workflow-finish" });
    expect(eventsOf(b, "charging")).toEqual([]);
    expect(eventsOf(b, "charged")).toEqual([
      expect.objectContaining({
        rootExecutionId: second.executionId,
        status: OutboundCallOutcomeStatus.Reconciled,
      }),
      expect.objectContaining({
        rootExecutionId: first,
        status: OutboundCallOutcomeStatus.Replayed,
      }),
    ]);
    const calls = await logOf(b, "default", second.executionId);
    expect(calls).toContainEqual(
      expect.objectContaining({
        kind: ExecutionLeaseEventKind.OutboundCall,
        outcome: OutboundCallEventOutcome.LeaseSuperseded,
        supersededLease: { rootExecutionId: first, leaseExecutionId: first, token: 1 },
      }),
    );
    // the tree whose lease B's check closed: its next take names A at the token it held
    const takeover = (await logOf(b, "default", first)).find(
      (row) => row.kind === ExecutionLeaseEventKind.Takeover,
    );
    expect(takeover).toMatchObject({
      holderInstanceId: b.instanceId,
      previousHolderInstanceId: a.instanceId,
      previousToken: 1,
      token: 2,
    });
    const [intent, ...others] = await intents();
    expect(others).toEqual([]);
    expect(intent).toMatchObject({
      status: OutboundCallStatus.Completed,
      attempt: 1,
      businessKey: "order:order-42",
      leaseExecutionId: second.executionId,
    });

    // A, thawed, answers late under the lease B's check closed: fenced, nothing stored or charged
    a.thaw();
    await a.send("open");
    expect(await aRun).toHaveProperty("error");
    expect(eventsOf(a, "charged")).toEqual([]);
    expect(await intents()).toEqual([intent]);
    expect(await gateway()).toEqual({
      attempts: [{ order_id: "order-42", instance_id: a.instanceId }],
      charges: [{ order_id: "order-42", instance_id: a.instanceId }],
    });
  }, 180_000);
});
