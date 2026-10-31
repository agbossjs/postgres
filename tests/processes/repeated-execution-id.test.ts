/**
 * agbossjs/agboss#591 on PostgreSQL — the charge of the issue: an `IdGenerator` that starts again at
 * `execution-1` on a kept database (a restarted sequential generator; each application instance
 * here has its own, as two processes would) gave the second order the first order's execution id,
 * so its step-keyed charge (`execution-1:charge-action:1:charge`) found the first order's stored
 * result and "replayed" its receipt — the second order never charged. Now every minted execution
 * id is kept in `agboss_execution_ids` before anything else of its tree is written: the repeat is
 * `DuplicateExecutionIdError`, nothing of it reaches the gateway, the first tree is untouched; of
 * two instances minting one id at once, one tree runs. Built with the public `createApp` on the
 * test's own schema, each instance its own pool.
 */
import { createApp, DuplicateExecutionIdError, IdGenerator, Injectable } from "@agboss/core";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresExecutionRecordRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
} from "../../src/index.js";
import { ChargeWorkflowStart } from "../fixtures/charge.workflow.js";
import { openGate } from "../fixtures/process-log.js";
import { storeLayoutOf } from "../fixtures/store-layout.application.js";
import { onSchema, testDatabase } from "../support/database.js";

const database = testDatabase();

/** A sequential generator of one instance: `execution-1`, `execution-2`, … from its start. */
@Injectable()
class RestartingIdGenerator extends IdGenerator {
  /** What this instance minted so far (a thread id the tenant has is minted again, #550). */
  readonly minted = { threads: 0, executions: 0 };

  newThreadId(): string {
    this.minted.threads += 1;
    return `thread-${String(this.minted.threads)}`;
  }

  newExecutionId(): string {
    this.minted.executions += 1;
    return `execution-${String(this.minted.executions)}`;
  }
}

type App = Awaited<ReturnType<typeof createApp>>;
const opened: App[] = [];

/** One application instance on the test's schema, with its own pool and its own generator. */
async function instance(): Promise<App> {
  const app = await createApp(
    storeLayoutOf([
      RestartingIdGenerator,
      PostgresExecutionLeaseRepository,
      PostgresFencedEffectRepository,
      PostgresOutboundCallRepository,
      PostgresExecutionRecordRepository,
    ]),
    { env: "process" },
  );
  opened.push(app);
  return app;
}

beforeAll(async () => {
  process.env.AGBOSS_PROCESS_DATABASE_URL = database.url();
  process.env.AGBOSS_PROCESS_MESH_PEER_KEY = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  openGate();
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
    `TRUNCATE test_gateway_attempts, test_gateway_charges, agboss_outbound_calls,
       agboss_execution_ids, agboss_execution_leases, agboss_fenced_effect_marks CASCADE`,
  );
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

/** The orders the gateway charged, by the key each was sent under. */
async function charges(): Promise<readonly { order_id: string; idempotency_key: string }[]> {
  const { rows } = await onSchema(
    database.url(),
    "SELECT order_id, idempotency_key FROM test_gateway_charges ORDER BY order_id",
  );
  return rows as { order_id: string; idempotency_key: string }[];
}

const charge = (app: App, name: string) =>
  app.execute(ChargeWorkflowStart, { name }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );

describe("agbossjs/agboss#591 on PostgreSQL: a repeated execution id never replays another order's charge", () => {
  it("a restarted generator's execution-1 on a kept database: the second order is refused, the gateway charged the first only", async () => {
    const first = await instance();
    const charged = await charge(first, "order-A");
    const restarted = await instance();

    const repeated = await charge(restarted, "order-B");

    expect(charged).toMatchObject({ result: { executionId: "execution-1" } });
    expect(repeated).toMatchObject({ error: expect.any(DuplicateExecutionIdError) as unknown });
    expect(String((repeated as { error: unknown }).error)).not.toContain("execution-1");
    expect(await charges()).toEqual([
      { order_id: "order-A", idempotency_key: "execution-1:charge-action:1:charge" },
    ]);
    const { rows } = await onSchema(
      database.url(),
      "SELECT lease_epoch FROM agboss_execution_leases WHERE root_execution_id = 'execution-1'",
    );
    expect(rows).toEqual([{ lease_epoch: 1 }]);
    const next = await charge(restarted, "order-B");
    expect(next).toMatchObject({ result: { executionId: "execution-2" } });
    expect((await charges()).map((row) => row.order_id)).toEqual(["order-A", "order-B"]);
  });

  it("two instances minting execution-1 at once: one order is charged, the other refused", async () => {
    const [left, right] = await Promise.all([instance(), instance()]);

    const outcomes = await Promise.all([charge(left, "order-L"), charge(right, "order-R")]);

    const refused = outcomes.filter((outcome) => "error" in outcome);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ error: expect.any(DuplicateExecutionIdError) as unknown });
    expect(await charges()).toHaveLength(1);
  });
});
