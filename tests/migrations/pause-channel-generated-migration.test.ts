import { PauseStatus } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { migratePostgres } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { instanceOn, pauseOf } from "../stores/pause-fixtures.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";

/**
 * agbossjs/agboss#1104: migration 0033 makes `agboss_pauses.channel` a stored generated column of
 * `record->>'channel'`. A pause an instance of an earlier version inserts after the migration — the
 * insert without `channel` — is still in a channel-filtered page; a row 0031's backfill missed (a
 * NULL channel) gets its channel from the migration.
 */
const BEFORE_0033 = {
  "0033_pause_channel_generated.sql": null,
  "0034_cancel_mark_on_lease_row.sql": null,
};

const OLD_INSERT = `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status, record)
  VALUES ('default', $1, $2, 'run-1', 'pending', $3::jsonb)`;

/** `pause` inserted the way a build before 0033 writes it: no `channel` in the column list. */
const insertedTheOldWay = (url: string, pauseId: string): Promise<unknown> => {
  const pause = pauseOf(pauseId);
  return onSchema(url, OLD_INSERT, [pauseId, pause.stepKey, JSON.stringify(pause)]);
};

const pageOf = async (url: string): Promise<readonly string[]> =>
  (
    await instanceOn(url).findPageByTenantId(
      "default",
      { statuses: [PauseStatus.Pending], channel: pauseOf("x").channel },
      10,
    )
  ).pauses.map((pause) => pause.pauseId);

describe("migration 0033: the pause's channel is generated", () => {
  it("a pause inserted without channel, after the migration, is in the channel-filtered page", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });

    await insertedTheOldWay(url, "old-writer");

    expect(await pageOf(url)).toEqual(["old-writer"]);
  });

  it("a row with a NULL channel before the migration has its channel after it, the index is back", async () => {
    const url = await freshSchema();
    await migrateWith({ url }, migrationsIn(migrationsFolder(BEFORE_0033)));
    await insertedTheOldWay(url, "late");
    expect(await pageOf(url)).toEqual([]);

    await migratePostgres({ url });

    expect(await pageOf(url)).toEqual(["late"]);
    const { rows } = await onSchema(
      url,
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'agboss_pauses_by_tenant' AND schemaname = current_schema()",
    );
    expect(rows).toHaveLength(1);
  });

  it("the column is generated: a write to it is refused, the store inserts without it", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });

    const refused = onSchema(
      url,
      `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status, channel, record)
       VALUES ('default', 'p', 's', 'r', 'pending', 'other', '{}'::jsonb)`,
    );
    await expect(refused).rejects.toMatchObject({ code: "428C9" });
    await instanceOn(url).findOrCreateByStepKey(pauseOf("by-store"));
    expect(await pageOf(url)).toEqual(["by-store"]);
  });

  it("the migration reruns: its file applied again over its own result changes nothing", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });
    await insertedTheOldWay(url, "kept");
    const sql = migrationsIn().find((file) => file.version === 33)?.sql ?? "";

    await onSchema(url, sql);

    expect(await pageOf(url)).toEqual(["kept"]);
  });
});
