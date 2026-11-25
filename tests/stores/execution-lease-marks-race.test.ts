import { InterruptMode, StoreClock, StoreTimeSource } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { PAUSE, STOP } from "../../src/stores/lease-marks.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * The marks only escalate, in the upsert itself (a security review of lease-marks): `FOR UPDATE` of
 * a row that does not exist yet locks nothing, so two first requests raced and an after-step one
 * could overwrite an immediate one. Each request here runs on a connection of its own.
 */
const database = testDatabase();

const TREE = (root: string) => ({ tenantId: "default", rootExecutionId: root });

const leasesOn = (instanceId: string) =>
  new PostgresExecutionLeaseRepository(
    connectionTo(database.url()),
    new StoreClock(StoreTimeSource.Test, new VirtualClock()),
    new TestApplicationContext({}, instanceId),
  );

describe("the marks' statements", () => {
  it("escalate in the SQL: a stop mode and a pause mode never fall back from immediate", () => {
    expect(STOP).toContain(
      "stop_mode = CASE WHEN lease.stop_mode = 'immediate' THEN 'immediate'\n      ELSE EXCLUDED.stop_mode END",
    );
    expect(STOP).toContain("stop_requested_at = COALESCE(lease.stop_requested_at,");
    expect(PAUSE).toContain("lease.external_pause_mode = 'immediate' THEN 'immediate'");
    expect(PAUSE).toContain("GREATEST(COALESCE(lease.fenced_through_token, 0), lease.token)");
  });
});

describe("two concurrent stops of a tree with no row", () => {
  it.each([
    [InterruptMode.AfterStep, InterruptMode.Immediate],
    [InterruptMode.Immediate, InterruptMode.AfterStep],
  ])("%s and %s, in either order, always end immediate", async (first, second) => {
    for (let round = 0; round < 10; round += 1) {
      const tree = TREE(`race-stop-${first}-${String(round)}`);
      await Promise.all([
        leasesOn("instance-1").requestStop(tree, first),
        leasesOn("instance-2").requestStop(tree, second),
      ]);
      expect(await leasesOn("instance-3").stopOf(tree)).toEqual({ mode: InterruptMode.Immediate });
    }
  });
});

describe("two concurrent pauses of a tree with no row", () => {
  it("after-step and immediate always end immediate", async () => {
    for (let round = 0; round < 10; round += 1) {
      const tree = TREE(`race-pause-${String(round)}`);
      await Promise.all([
        leasesOn("instance-1").requestPause(tree, { mode: InterruptMode.AfterStep }),
        leasesOn("instance-2").requestPause(tree, { mode: InterruptMode.Immediate }),
      ]);
      const marks = await leasesOn("instance-3").markedOf(tree);
      expect(marks.pause?.mode).toBe(InterruptMode.Immediate);
    }
  });
});
