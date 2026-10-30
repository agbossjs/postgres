import {
  ExecutionLeaseEventKind,
  FencedEffectEventOutcome,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
  type FencedEffectRecord,
  type LeaseTakeoverRecord,
  type StepHandedOverRecord,
} from "@agboss/core";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseEventRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * The lease log's edges beyond the contract: every kind and every optional field round-trips (an
 * absent one stays absent), rows are found by tenant and root only, a row that is not a record is
 * refused, and a lost connection rejects every operation.
 */
const database = testDatabase();

const eventsOn = (url = database.url()) =>
  new PostgresExecutionLeaseEventRepository(connectionTo(url));

const step = { nodeId: "charge-action", visitNumber: 2, idempotencyKey: "root-e:charge:2" };

const takeover = (root: string, at: string): LeaseTakeoverRecord => ({
  kind: ExecutionLeaseEventKind.Takeover,
  occurredAt: at,
  tenantId: "acme",
  rootExecutionId: root,
  executionId: root,
  scopeKey: `acme:${root}`,
  token: 1,
  holderInstanceId: "instance-1",
  reason: LeaseTakeoverReason.RemoteChild,
});

const fenced = (root: string): FencedEffectRecord => ({
  kind: ExecutionLeaseEventKind.FencedEffect,
  occurredAt: "2026-01-05T09:00:00.250Z",
  tenantId: "acme",
  rootExecutionId: root,
  executionId: `${root}/child`,
  scopeKey: `acme:${root}`,
  token: 3,
  holderInstanceId: "instance-2",
  name: "charge",
  outcome: FencedEffectEventOutcome.Replayed,
  step,
  writtenToken: 2,
});

const handedOver = (root: string): StepHandedOverRecord => ({
  kind: ExecutionLeaseEventKind.HandedOver,
  occurredAt: "2026-01-05T09:00:00.500Z",
  tenantId: "acme",
  rootExecutionId: root,
  executionId: root,
  scopeKey: `acme:${root}`,
  token: 2,
  holderInstanceId: "instance-1",
  reason: HandOverReason.ApplicationStopping,
  site: HandOverSite.Compensation,
  step,
});

describe("PostgresExecutionLeaseEventRepository", () => {
  it("every kind round-trips with its own fields; an absent optional field stays absent, milliseconds kept", async () => {
    const events = eventsOn();
    const rows = [
      takeover("root-kinds", "2026-01-05T09:00:00.001Z"),
      fenced("root-kinds"),
      handedOver("root-kinds"),
    ];
    for (const row of rows) await events.save(row);

    const found = await events.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
      "acme",
      "root-kinds",
    );

    expect(found).toEqual(rows);
    expect(found[0]).not.toHaveProperty("previousHolderInstanceId");
    expect(found[0]).not.toHaveProperty("checkpointId");
    expect(found[2]).not.toHaveProperty("observedToken");
  });

  it("rows are found by their root, not by the execution they are about (a child's row is its root's)", async () => {
    const events = eventsOn();
    await events.save(fenced("root-child"));

    expect(
      await events.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("acme", "root-child/child"),
    ).toEqual([]);
    expect(
      await events.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("acme", "root-child"),
    ).toHaveLength(1);
  });

  it("the sweep removes by time across every tree and tenant, and nothing at or after the cutoff", async () => {
    const events = eventsOn();
    await events.save(takeover("root-old", "2026-01-05T08:59:59.999Z"));
    await events.save({ ...takeover("root-old", "2026-01-05T08:00:00.000Z"), tenantId: "other" });
    await events.save(takeover("root-kept", "2026-01-05T09:00:00.000Z"));

    await events.deleteByOccurredAtBefore(new Date("2026-01-05T09:00:00.000Z"));

    expect(
      await events.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("acme", "root-old"),
    ).toEqual([]);
    expect(
      await events.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("other", "root-old"),
    ).toEqual([]);
    expect(
      await events.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("acme", "root-kept"),
    ).toHaveLength(1);
  });

  it("a row that is not a lease record is refused when read, never handed to the framework", async () => {
    const events = eventsOn();
    await onSchema(
      database.url(),
      `INSERT INTO agboss_execution_lease_events (tenant_id, root_execution_id, occurred_at, record)
       VALUES ('acme', 'root-bad', now(), $1::jsonb)`,
      [JSON.stringify({ ...takeover("root-bad", "x"), reason: "stolen" })],
    );

    await expect(
      events.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("acme", "root-bad"),
    ).rejects.toThrow();
  });

  it("a lost connection rejects ping, save, the read and the sweep: the core logs lease-event.failed", async () => {
    const down = eventsOn("postgres://postgres:pw@127.0.0.1:1/postgres");

    await expect(down.ping()).rejects.toThrow();
    await expect(down.save(takeover("root-down", "2026-01-05T09:00:00.000Z"))).rejects.toThrow();
    await expect(
      down.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("acme", "root-down"),
    ).rejects.toThrow();
    await expect(down.deleteByOccurredAtBefore(new Date())).rejects.toThrow();
  });
});
