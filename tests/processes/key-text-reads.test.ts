/**
 * agbossjs/agboss#568 (#575) and #580 on PostgreSQL: the operator's reads take a tenant id and a root execution id
 * as keys' text. `pg` writes a JS string as UTF-8, so a lone surrogate reaches the database as
 * U+FFFD: on the stores alone `t\uD800` reads tenant `t�`'s pending charge, lease log and calls,
 * and `r\uD800` root `r�`'s lease log. Through the application every such read is refused with
 * `dto.invalid` naming the field and the rule, never the id, before the database is asked; an
 * accepted id reads its own rows as before. Built with the public `createApp` on the test's schema.
 */
import {
  createApp,
  DtoValidationError,
  ExecutionLeaseEventKind,
  LeaseTakeoverReason,
  OutboundCallStatus,
  type App,
  type ExecutionLease,
  type LeaseTakeoverRecord,
} from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseEventRepository,
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
} from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { storeLayoutOf } from "../fixtures/store-layout.application.js";

const database = testDatabase();

/** The tenant and the root whose rows a lone surrogate would read on PostgreSQL. */
const TENANT = "t�";
const ROOT = "r�";

const POSTGRES_STORES = [
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
  PostgresExecutionLeaseEventRepository,
];

let app: App;

/** A takeover row of `rootExecutionId` in `tenantId`'s lease log. */
const takeoverOf = (tenantId: string, rootExecutionId: string): LeaseTakeoverRecord => ({
  kind: ExecutionLeaseEventKind.Takeover,
  // now: the application's recovery sweep removes rows older than its leaseEventRetention
  occurredAt: new Date().toISOString(),
  tenantId,
  rootExecutionId,
  executionId: rootExecutionId,
  scopeKey: `${encodeURIComponent(tenantId)}:${encodeURIComponent(rootExecutionId)}`,
  token: 2,
  holderInstanceId: "instance-2",
  reason: LeaseTakeoverReason.Recovered,
  previousHolderInstanceId: "instance-1",
  previousToken: 1,
});

/** A pending charge of `lease`'s tree, recorded as `OutboundCalls.send` records it. */
async function pendingChargeOf(lease: ExecutionLease): Promise<void> {
  const key = {
    scopeKey: `${encodeURIComponent(lease.tenantId)}:${encodeURIComponent(lease.rootExecutionId)}`,
    tenantId: lease.tenantId,
    leaseExecutionId: lease.rootExecutionId,
    token: lease.leaseEpoch,
    idempotencyKey: `${lease.rootExecutionId}:charge-action:1`,
    name: "charge",
  };
  await app.resolve(PostgresOutboundCallRepository).saveIfAbsent(key, {
    rootExecutionId: lease.rootExecutionId,
    executionId: lease.rootExecutionId,
    workflow: "charge-workflow",
    target: "payments",
    operation: "charge",
    idempotencyKey: `${key.idempotencyKey}:${key.name}`,
    request: '{"orderId":"order-7"}',
    attempt: 1,
    attemptOwner: "owner-1",
    step: { nodeId: "charge-action", visitNumber: 1 },
  });
}

/** Every read of an operator, under `tenantId` and `rootExecutionId`. */
const readsOf = (tenantId: string, rootExecutionId: string) =>
  [
    ["leaseEventsOf", () => app.leaseEventsOf({ tenantId, rootExecutionId })],
    ["outboundCallsOf", () => app.outboundCallsOf({ tenantId, rootExecutionId })],
    ["pendingOutboundCalls", () => app.pendingOutboundCalls({ tenantId })],
  ] as const;

const rejectionOf = (call: () => Promise<unknown>): Promise<unknown> =>
  call().then(
    () => undefined,
    (error: unknown) => error,
  );

beforeAll(async () => {
  process.env.AGBOSS_PROCESS_DATABASE_URL = database.url();
  process.env.AGBOSS_PROCESS_MESH_PEER_KEY = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  app = await createApp(storeLayoutOf(POSTGRES_STORES), { env: "process" });
  const lease = await app
    .resolve(PostgresExecutionLeaseRepository)
    .acquire(TENANT, "r1", seconds(30));
  if (lease === undefined) throw new Error("the tenant's lease was not granted");
  await pendingChargeOf(lease);
  const log = app.resolve(PostgresExecutionLeaseEventRepository);
  await log.save(takeoverOf(TENANT, "r1"));
  await log.save(takeoverOf("default", ROOT));
});

afterAll(async () => {
  await app.close();
});

describe("agbossjs/agboss#568, #580 on PostgreSQL: a key's text at the operator's reads", () => {
  it("the stores alone merge t\\uD800 into t\\uFFFD and r\\uD800 into r\\uFFFD — what the reads keep out", async () => {
    const calls = app.resolve(PostgresOutboundCallRepository);
    const log = app.resolve(PostgresExecutionLeaseEventRepository);

    expect(
      await calls.findAllByTenantIdAndStatus("t\uD800", OutboundCallStatus.Pending),
    ).toHaveLength(1);
    expect(
      await log.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("t\uD800", "r1"),
    ).toHaveLength(1);
    expect(
      await log.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("default", "r\uD800"),
    ).toHaveLength(1);
  });

  it("an accepted tenant and root read their own rows", async () => {
    expect(await app.pendingOutboundCalls({ tenantId: TENANT })).toEqual([
      expect.objectContaining({ status: OutboundCallStatus.Pending }),
    ]);
    expect(await app.outboundCallsOf({ tenantId: TENANT, rootExecutionId: "r1" })).toHaveLength(1);
    expect(await app.leaseEventsOf({ tenantId: TENANT, rootExecutionId: "r1" })).toHaveLength(1);
    expect(await app.leaseEventsOf({ tenantId: "default", rootExecutionId: ROOT })).toHaveLength(1);
  });

  it.for(["t\uD800", "t\uDFFF"])(
    "a lone surrogate tenant id (%j) never reads t\\uFFFD's rows: refused, tenantId named, the id not",
    async (tenantId) => {
      for (const [read, made] of readsOf(tenantId, "r1")) {
        const error = await rejectionOf(made);
        expect(error, read).toBeInstanceOf(DtoValidationError);
        const { message } = error as Error;
        expect(message, read).toContain("tenantId");
        expect(message, read).toContain("(lone-surrogate)");
        expect(message, read).not.toContain(tenantId);
      }
    },
  );

  it.for(["r\uD800", "r\uDFFF"])(
    "a lone surrogate root execution id (%j) never reads r\\uFFFD's lease log: refused, rootExecutionId named",
    async (rootExecutionId) => {
      for (const [read, made] of readsOf("default", rootExecutionId).slice(0, 2)) {
        const error = await rejectionOf(made);
        expect(error, read).toBeInstanceOf(DtoValidationError);
        const { message } = error as Error;
        expect(message, read).toContain("rootExecutionId");
        expect(message, read).toContain("(lone-surrogate)");
        expect(message, read).not.toContain(rootExecutionId);
      }
    },
  );

  it.for([
    ["a zero-width space", "t​", "format-character"],
    ["decomposed text", "Café", "not-nfc"],
    ["an edge space", " acme", "spacing"],
  ] as const)(
    "a tenant id with %s is refused at every read, naming the rule",
    async ([, tenantId, rule]) => {
      for (const [read, made] of readsOf(tenantId, "r1")) {
        const { message } = (await rejectionOf(made)) as Error;
        expect(message, read).toContain(`(${rule})`);
        expect(message, read).not.toContain(tenantId);
      }
    },
  );
});
