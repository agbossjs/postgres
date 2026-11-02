import { OutboundCallLeaseState } from "@agboss/core";
import { VirtualClock, TestStoreClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import {
  migratePostgres,
  PostgresExecutionLeaseRepository,
  PostgresOutboundCallRepository,
} from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { TestApplicationContext } from "../support/application-context.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#505, #508: migrations 0014–0016 on a database a 0.1.0 package migrated — its
 * leases (held, expired, released) keep working: they are not `superseded`, an expired one taken
 * names its holder, a held one is closed by `leaseStateOf` once expired; the new tables are empty.
 */
const BEFORE = {
  "0014_execution_lease_superseded.sql": null,
  "0015_fenced_effect_business_keys.sql": null,
  "0016_outbound_calls.sql": null,
  "0017_execution_lease_finished.sql": null,
  "0018_execution_ids.sql": null,
  "0019_execution_ids_from_outbound_calls.sql": null,
  "0020_pauses_by_tree.sql": null,
  "0021_pause_answers_by_tree.sql": null,
};

const leasesOn = (url: string, clock: VirtualClock, instanceId: string) =>
  new PostgresExecutionLeaseRepository(
    connectionTo(url),
    new TestStoreClock(clock),
    new TestApplicationContext({}, instanceId),
  );

describe("migrations 0014–0016 keep the leases written before them", () => {
  it("#508: leases taken before 0014 are not superseded; taken, renewed and closed as before", async () => {
    const url = await freshSchema();
    await migrateWith({ url }, migrationsIn(migrationsFolder(BEFORE)));
    const clock = new VirtualClock();
    const at = (length: number) => new Date(clock.now().getTime() + length);
    // the rows as the 0.1.0 lease store wrote them: no superseded column yet
    for (const [root, expiresAt, released] of [
      ["root-expired", at(seconds(30)), false],
      ["root-held", at(seconds(90)), false],
      ["root-released", at(seconds(90)), true],
    ] as const)
      await onSchema(
        url,
        `INSERT INTO agboss_execution_leases (tenant_id, root_execution_id, holder_instance_id,
           lease_epoch, expires_at, released) VALUES ('default', $1, 'instance-1', 1, $2, $3)`,
        [root, expiresAt, released],
      );
    const before = leasesOn(url, clock, "instance-1");
    const held = {
      tenantId: "default",
      rootExecutionId: "root-held",
      holderInstanceId: "instance-1",
      leaseEpoch: 1,
      expiresAt: at(seconds(90)),
      remaining: seconds(30),
    };

    const report = await migratePostgres({ url });
    await clock.advance(seconds(31));

    expect(report.applied.map((migration) => migration.version)).toEqual([
      14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    const { rows } = await onSchema(
      url,
      "SELECT root_execution_id, superseded FROM agboss_execution_leases ORDER BY root_execution_id",
    );
    expect(rows).toEqual([
      { root_execution_id: "root-expired", superseded: false },
      { root_execution_id: "root-held", superseded: false },
      { root_execution_id: "root-released", superseded: false },
    ]);
    const after = leasesOn(url, clock, "instance-2");
    expect(await after.acquire("default", "root-expired", seconds(30))).toMatchObject({
      leaseEpoch: 2,
      takenOverFrom: { holderInstanceId: "instance-1", leaseEpoch: 1 },
    });
    expect(await after.acquire("default", "root-released", seconds(30))).not.toHaveProperty(
      "takenOverFrom",
    );
    expect(await before.renew(held, seconds(30))).toBe(seconds(30));
    const calls = new PostgresOutboundCallRepository(connectionTo(url), new TestStoreClock(clock));
    const state = { tenantId: "default", leaseExecutionId: "root-held", token: 1 };
    expect(await calls.leaseStateOf(state)).toBe(OutboundCallLeaseState.Live);
    await clock.advance(seconds(31));
    expect(await calls.leaseStateOf(state)).toBe(OutboundCallLeaseState.Superseded);
    expect(await calls.findAllByTenantIdAndRootExecutionId("default", "root-held")).toEqual([]);
    const business = await onSchema(url, "SELECT * FROM agboss_fenced_effect_business_results");
    expect(business.rows).toEqual([]);
  });
});
