import { StoreClock, StoreTimeSource } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresExecutionLeaseRepository } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { TestApplicationContext } from "../support/application-context.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#847 (G7): migration 0029 on a database at 0028 — the leases' `lease_epoch` is
 * `token`. Every row keeps its value (a tree's next take is its last token + 1, none handed out
 * twice), the CHECK still refuses a token below 1 under its new name, and the leases written before
 * it are renewed, yielded, reclaimed, retired and taken over by their old tokens.
 */
const leasesOn = (url: string, clock: VirtualClock, instanceId: string) =>
  new PostgresExecutionLeaseRepository(
    connectionTo(url),
    new StoreClock(StoreTimeSource.Test, clock),
    new TestApplicationContext({}, instanceId),
  );

/** instance-1's lease on `root` at `token`, as the store wrote it before 0029. */
const leaseOf = (root: string, token: number, expiresAt: Date) => ({
  tenantId: "default",
  rootExecutionId: root,
  holderInstanceId: "instance-1",
  token,
  expiresAt,
  remaining: seconds(30),
});

/** A schema at 0028: the lease table with its `lease_epoch` column. */
async function schemaAt28(): Promise<string> {
  const url = await freshSchema();
  await migrateWith(
    { url },
    migrationsIn(
      migrationsFolder({
        "0029_execution_lease_token.sql": null,
        "0030_a2a_direct_messages.sql": null,
        "0031_pause_deadlines_and_notices.sql": null,
      }),
    ),
  );
  return url;
}

describe("migration 0029 names the lease's fencing token `token`", () => {
  it("#847: old rows keep their tokens and are renewed, yielded, reclaimed, retired and taken over by them", async () => {
    const url = await schemaAt28();
    const clock = new VirtualClock();
    const at = (length: number) => new Date(clock.now().getTime() + length);
    for (const [root, epoch, expiresAt, released, finished] of [
      ["root-held", 7, at(seconds(90)), false, false],
      ["root-yielding", 4, at(seconds(90)), false, false],
      ["root-expired", 3, at(seconds(30)), false, false],
      ["root-released", 5, at(seconds(90)), true, false],
      ["root-finished", 2, at(seconds(90)), true, true],
    ] as const)
      await onSchema(
        url,
        `INSERT INTO agboss_execution_leases (tenant_id, root_execution_id, holder_instance_id,
           lease_epoch, expires_at, released, finished) VALUES ('default', $1, 'instance-1', $2, $3, $4, $5)`,
        [root, epoch, expiresAt, released, finished],
      );

    const report = await migratePostgres({ url });
    await clock.advance(seconds(31));

    expect(report.applied.map((migration) => migration.version)).toEqual([29, 30, 31]);
    const columns = await onSchema(
      url,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'agboss_execution_leases'
         AND column_name IN ('token', 'lease_epoch')`,
    );
    expect(columns.rows).toEqual([{ column_name: "token" }]);
    const { rows } = await onSchema(
      url,
      "SELECT root_execution_id, token FROM agboss_execution_leases ORDER BY root_execution_id",
    );
    expect(rows).toEqual([
      { root_execution_id: "root-expired", token: 3 },
      { root_execution_id: "root-finished", token: 2 },
      { root_execution_id: "root-held", token: 7 },
      { root_execution_id: "root-released", token: 5 },
      { root_execution_id: "root-yielding", token: 4 },
    ]);

    const holder = leasesOn(url, clock, "instance-1");
    const other = leasesOn(url, clock, "instance-2");
    const held = leaseOf("root-held", 7, at(seconds(59)));
    expect(await other.acquire("default", "root-held", seconds(30))).toBeUndefined();
    expect(await holder.renew(held, seconds(30))).toBe(seconds(30));
    expect(await holder.renew({ ...held, token: 6 }, seconds(30))).toBeUndefined();
    const yielding = leaseOf("root-yielding", 4, at(seconds(59)));
    expect(await holder.yield(yielding)).toBe(seconds(59));
    expect(await holder.reclaim(yielding, seconds(30))).toMatchObject({ token: 5 });
    expect(await other.acquire("default", "root-expired", seconds(30))).toMatchObject({
      token: 4,
      takenOverFrom: { holderInstanceId: "instance-1", token: 3 },
    });
    expect(await other.acquire("default", "root-released", seconds(30))).toMatchObject({
      token: 6,
    });
    expect(await other.acquire("default", "root-finished", seconds(30))).toBeUndefined();
    await holder.retire(held);
    await clock.advance(seconds(60));
    expect(await other.acquire("default", "root-held", seconds(30))).toBeUndefined();
  });

  it("#847: the CHECK keeps refusing a token below 1, under the column's name", async () => {
    const url = await schemaAt28();

    await migratePostgres({ url });

    const constraints = await onSchema(
      url,
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'agboss_execution_leases'::regclass AND contype = 'c'`,
    );
    expect(constraints.rows).toEqual([{ conname: "agboss_execution_leases_token_check" }]);
    await expect(
      onSchema(
        url,
        `INSERT INTO agboss_execution_leases (tenant_id, root_execution_id, holder_instance_id,
           token, expires_at, released) VALUES ('default', 'root-zero', 'instance-1', 0, now(), false)`,
      ),
    ).rejects.toThrow(/agboss_execution_leases_token_check/u);
  });
});
