import { PauseResolution, PauseStatus } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { migratePostgres } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { APPROVED, LATER, MID, RECIPIENTS, instanceOn, pauseOf } from "../stores/pause-fixtures.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";

/**
 * agbossjs/agboss#936 AC2: migration 0031 on a database at 0030 — the pauses a 0.1.0 store wrote
 * have no deadline, reminder or channel column. They keep every row and every `record` as it was
 * (the migration only adds), the channel column is filled from the record, and the new queries
 * (the scans, the pages, the mailboxes) answer on them; a pause of before is answered and its
 * notices written like any other.
 */
const OLD = (pauseId: string, status: string, resolvedAt: string | null) => ({
  ...pauseOf(pauseId),
  stepKey: `run-1:${pauseId}`,
  status,
  isSent: status !== "pending" || pauseId === "sent",
  ...(resolvedAt === null ? {} : { resolvedAt, resolution: PauseResolution.Cancelled }),
});

/** A schema at 0030 holding pauses of every status. */
async function schemaAt0030(): Promise<string> {
  const url = await freshSchema();
  await migrateWith(
    { url },
    migrationsIn(migrationsFolder({ "0031_pause_deadlines_and_notices.sql": null })),
  );
  for (const record of [
    OLD("waiting", "pending", null),
    OLD("sent", "pending", null),
    OLD("old-cancelled", "cancelled", "2026-01-01T09:00:00.000Z"),
  ])
    await onSchema(
      url,
      `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status, resolved_at, record)
       VALUES ('default', $1, $2, 'run-1', $3, $4, $5::jsonb)`,
      [
        record.pauseId,
        record.stepKey,
        record.status,
        record.resolvedAt ?? null,
        JSON.stringify(record),
      ],
    );
  return url;
}

const recordsOf = async (url: string): Promise<readonly unknown[]> => {
  const { rows } = await onSchema(url, "SELECT pause_id, record FROM agboss_pauses ORDER BY seq");
  return rows.map((row: unknown) => row);
};

describe("migration 0031: pause deadlines and notices", () => {
  it("pauses of 0030 migrate; channel filled; new queries answer", async () => {
    const url = await schemaAt0030();
    const before = await recordsOf(url);

    const report = await migratePostgres({ url });
    const store = instanceOn(url);

    expect(report.applied.map((migration) => migration.version)).toEqual([31]);
    expect(await recordsOf(url)).toEqual(before);
    const { rows } = await onSchema(
      url,
      "SELECT pause_id, channel, expires_at, remind_at FROM agboss_pauses ORDER BY seq",
    );
    expect(rows).toEqual(
      ["waiting", "sent", "old-cancelled"].map((pause_id) => ({
        pause_id,
        channel: "refund-approval-channel",
        expires_at: null,
        remind_at: null,
      })),
    );
    expect(await store.findPendingByExpiresAtBefore(LATER, 10)).toEqual([]);
    expect(await store.findPendingByRemindAtBefore(LATER, 10)).toEqual([]);
    const open = await store.findOpenAfter(undefined, 10);
    expect(open.pauses.map((pause) => pause.pauseId)).toEqual(["waiting", "sent"]);
    const page = await store.findPageByTenantId(
      "default",
      {
        statuses: [PauseStatus.Pending, PauseStatus.Cancelled],
        channel: "refund-approval-channel",
      },
      10,
    );
    expect(page.pauses).toHaveLength(3);
    expect(await store.countNotices()).toEqual({ live: 0, dead: 0 });
    expect((await store.findClosedByResolvedAtBefore(LATER, 10)).pauses).toEqual([
      expect.objectContaining({ pauseId: "old-cancelled" }),
    ]);
  });

  it("a pause of before is answered, its notices written, and a second migration changes nothing", async () => {
    const url = await schemaAt0030();
    await migratePostgres({ url });
    const store = instanceOn(url);

    const resolved = await store.resolveByTenantIdAndPauseId(
      "default",
      "sent",
      APPROVED,
      MID,
      RECIPIENTS,
    );
    const again = await migratePostgres({ url });

    expect(resolved).toMatchObject({ status: PauseStatus.Resolved, isSent: true });
    expect(await store.countNotices()).toEqual({ live: 3, dead: 0 });
    expect(again.applied).toEqual([]);
    expect(await store.findByTenantIdAndPauseId("default", "waiting")).toMatchObject({
      status: PauseStatus.Pending,
    });
  });
});
