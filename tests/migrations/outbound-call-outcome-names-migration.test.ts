import { describe, expect, it } from "vitest";
import { migratePostgres } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";

/**
 * agbossjs/agboss#825: migration 0027 on a database at 0026 — the lease log's outbound-call rows
 * named the attempt taken over and the lease closed both "superseded". Each is rewritten once:
 * `superseded` → `attempt-superseded`, `lease-superseded` → `lease-closed` with its
 * `supersededLease` as `closedLease`, in the log and in a kept record's `leaseEvents`; every other
 * row — another kind, another outcome — is left as it was.
 */
const step = { nodeId: "pay-action", visitNumber: 1, idempotencyKey: "root-1:pay-action:1" };
const LEASE = { scopeKey: "acme:root-1", token: 2, holderInstanceId: "instance-1" };

const OLD_ROWS = [
  { kind: "outbound-call", name: "charge", outcome: "superseded", step },
  {
    kind: "outbound-call",
    name: "charge",
    outcome: "lease-superseded",
    step,
    supersededLease: LEASE,
  },
  { kind: "outbound-call", name: "charge", outcome: "sent", step },
  { kind: "fenced-effect", name: "charge", outcome: "superseded", step },
];

const NEW_ROWS = [
  { kind: "outbound-call", name: "charge", outcome: "attempt-superseded", step },
  { kind: "outbound-call", name: "charge", outcome: "lease-closed", step, closedLease: LEASE },
  { kind: "outbound-call", name: "charge", outcome: "sent", step },
  { kind: "fenced-effect", name: "charge", outcome: "superseded", step },
];

/** A schema at 0026 holding the lease log and a kept record of before. */
async function schemaWithOldRows(): Promise<string> {
  const url = await freshSchema();
  await migrateWith(
    { url },
    migrationsIn(
      migrationsFolder({
        "0027_outbound_call_outcome_names.sql": null,
        "0028_a2a_task_mesh_body_hash.sql": null,
        "0029_execution_lease_token.sql": null,
      }),
    ),
  );
  for (const [index, record] of OLD_ROWS.entries())
    await onSchema(
      url,
      `INSERT INTO agboss_execution_lease_events (tenant_id, root_execution_id, occurred_at, record)
       VALUES ('acme', 'root-1', $1, $2::jsonb)`,
      [new Date(Date.UTC(2026, 0, 5, 9, 0, index)), JSON.stringify(record)],
    );
  const kept = { executionId: "root-1", leaseEvents: OLD_ROWS };
  const plain = { executionId: "root-2", leaseEvents: [OLD_ROWS[2]] };
  for (const record of [kept, plain])
    await onSchema(
      url,
      `INSERT INTO agboss_execution_history (tenant_id, execution_id, thread_id, started_at, record)
       VALUES ('acme', $1, 'thread-1', '2026-01-05T09:00:00Z', $2::jsonb)`,
      [record.executionId, JSON.stringify(record)],
    );
  return url;
}

describe("migration 0027 names the outbound call's two meanings of superseded apart", () => {
  it("#825: the lease log's rows and a kept record's copies are renamed; every other row as it was", async () => {
    const url = await schemaWithOldRows();

    const report = await migratePostgres({ url });

    expect(report.applied.map((migration) => migration.version)).toEqual([27, 28, 29]);
    const log = await onSchema(url, "SELECT record FROM agboss_execution_lease_events ORDER BY id");
    expect(log.rows.map((row: { record: unknown }) => row.record)).toEqual(NEW_ROWS);
    const kept = await onSchema(
      url,
      "SELECT execution_id, record->'leaseEvents' AS events FROM agboss_execution_history ORDER BY execution_id",
    );
    expect(kept.rows).toEqual([
      { execution_id: "root-1", events: NEW_ROWS },
      { execution_id: "root-2", events: [NEW_ROWS[2]] },
    ]);
  });
});
