import { TestStoreClock, VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresExecutionLeaseRepository } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { TestApplicationContext } from "../support/application-context.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#638: on a database of before #591, a `ParentInstance` child has no lease row, but
 * every call it made through `OutboundCalls` is a row of `agboss_outbound_calls` naming it
 * (`record.executionId`) — and its step-keyed key (`<childId>:<node>:<visit>:<name>`, no tenant,
 * no scope) has reached the other system. Migration 0019 keeps those ids too: a generator that
 * repeats one is refused, so no new order sends a key a gateway answers with an old payment.
 */
describe("migration 0019 keeps the ids of every execution that made an outbound call", () => {
  it("#638: a ParentInstance child's call of before: its id is taken, for any tenant; a new id kept", async () => {
    const url = await freshSchema();
    const before = migrationsFolder({
      "0018_execution_ids.sql": null,
      "0019_execution_ids_from_outbound_calls.sql": null,
      "0020_pauses_by_tree.sql": null,
    });
    await migrateWith({ url }, migrationsIn(before));
    await onSchema(
      url,
      `INSERT INTO agboss_execution_leases (tenant_id, root_execution_id, holder_instance_id,
         lease_epoch, expires_at, released) VALUES ('acme', 'old-root', 'instance-1', 3, now(), true)`,
    );
    for (const [childId, businessKey] of [
      ["old-child-3", null],
      ["old-child-4", "order:4"],
    ] as const)
      await onSchema(
        url,
        `INSERT INTO agboss_outbound_calls (scope_key, idempotency_key, name, tenant_id,
           root_execution_id, business_key, status, attempt, attempt_owner, record)
         VALUES ('acme:old-root', $1 || ':pay-action:1', 'pay', 'acme', 'old-root', $3,
           'completed', 1, 'owner-1', jsonb_build_object('executionId', $2::text))`,
        [childId, childId, businessKey],
      );

    const report = await migratePostgres({ url });
    const leases = new PostgresExecutionLeaseRepository(
      connectionTo(url),
      new TestStoreClock(new VirtualClock()),
      new TestApplicationContext({}, "instance-1"),
    );

    expect(report.applied.map((migration) => migration.version)).toEqual([18, 19, 20]);
    const { rows } = await onSchema(
      url,
      "SELECT execution_id, tenant_id FROM agboss_execution_ids ORDER BY execution_id",
    );
    expect(rows).toEqual([
      { execution_id: "old-child-3", tenant_id: "acme" },
      { execution_id: "old-child-4", tenant_id: "acme" },
      { execution_id: "old-root", tenant_id: "acme" },
    ]);
    for (const executionId of ["old-child-3", "old-child-4", "old-root"])
      expect(await leases.saveExecutionIdIfAbsent({ executionId, tenantId: "globex" })).toBe(false);
    expect(await leases.saveExecutionIdIfAbsent({ executionId: "new-1", tenantId: "acme" })).toBe(
      true,
    );
  });
});
