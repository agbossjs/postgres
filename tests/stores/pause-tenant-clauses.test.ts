import { PauseStatus } from "@agboss/core";
import { NO_RECIPIENTS } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import {
  APPROVED,
  DEADLINE,
  LATER,
  MID,
  NINE,
  RECIPIENTS,
  expiringPauseOf,
  instanceOn,
  pauseOf,
} from "./pause-fixtures.js";

/**
 * The tenant of a pause's statements (agbossjs/agboss#1302): tenants that share every id never
 * touch each other's pauses. Dropping a tenant or root predicate from a statement, one at a time,
 * fails one of these.
 */
const database = testDatabase();
const store = (): ReturnType<typeof instanceOn> => instanceOn(database.url());
const PAUSE = "tenant-a";
const OTHER = "tenant-b";

/** A pause `id` of each tenant, `PAUSE`'s first. */
async function twins(id: string): Promise<void> {
  for (const tenantId of [PAUSE, OTHER])
    await store().findOrCreateByStepKey({ ...pauseOf(id), tenantId });
}

const statusOf = async (tenantId: string, id: string): Promise<PauseStatus | undefined> =>
  (await store().findByTenantIdAndPauseId(tenantId, id))?.status;

describe("pauses of two tenants that share their ids", () => {
  it("an answer to one tenant's pause leaves the other's pending", async () => {
    await twins("answered");

    await store().resolveByTenantIdAndPauseId(PAUSE, "answered", APPROVED, MID, NO_RECIPIENTS);

    expect(await statusOf(PAUSE, "answered")).toBe(PauseStatus.Resolved);
    expect(await statusOf(OTHER, "answered")).toBe(PauseStatus.Pending);
  });

  it("a pause is found by its tenant and its id, each alone", async () => {
    await store().findOrCreateByStepKey({ ...pauseOf("found"), tenantId: PAUSE });
    await store().findOrCreateByStepKey({ ...pauseOf("found-too"), tenantId: PAUSE });

    expect(await store().findByTenantIdAndPauseId(OTHER, "found")).toBeUndefined();
    expect(await store().findByTenantIdAndPauseId(PAUSE, "found-too")).toMatchObject({
      pauseId: "found-too",
    });
  });

  it("a markSent reads and marks its own tenant's pause, whatever the other's flag says", async () => {
    await twins("marked");
    await store().markSentByTenantIdAndPauseId(OTHER, "marked", NO_RECIPIENTS);
    // the tenant's row is the last written: a read of the id alone would find the other's first
    await onSchema(
      database.url(),
      "UPDATE agboss_pauses SET record = record WHERE tenant_id = $1 AND pause_id = 'marked'",
      [PAUSE],
    );

    await store().markSentByTenantIdAndPauseId(PAUSE, "marked", NO_RECIPIENTS);

    expect((await store().findByTenantIdAndPauseId(PAUSE, "marked"))?.isSent).toBe(true);
  });

  it("a reassignment moves its tenant's pause only", async () => {
    await twins("moved");

    await store().reassignByTenantIdAndPauseId(
      PAUSE,
      "moved",
      { pauseId: "moved-to", assignee: "bob" },
      NINE,
      NO_RECIPIENTS,
    );

    expect(await statusOf(PAUSE, "moved")).toBe(PauseStatus.Cancelled);
    expect(await statusOf(OTHER, "moved")).toBe(PauseStatus.Pending);
  });

  it("a replacement's step is numbered among the steps of its own tree: none of another tenant's, none of another tree's", async () => {
    await store().findOrCreateByStepKey({ ...pauseOf("numbered"), tenantId: PAUSE });
    // the step the replacement would take, held in another tenant's tree and in another tree
    const taken = pauseOf("elsewhere", "run-1:numbered~r1");
    await store().findOrCreateByStepKey({ ...taken, tenantId: OTHER });
    await store().findOrCreateByStepKey({ ...taken, tenantId: PAUSE, rootExecutionId: "run-2" });

    const made = await store().reassignByTenantIdAndPauseId(
      PAUSE,
      "numbered",
      { pauseId: "numbered-to", assignee: "bob" },
      NINE,
      NO_RECIPIENTS,
    );

    expect(made?.stepKey).toBe("run-1:numbered~r1");
  });
  it("a mark that the step took the decision, a flag that the channel was asked, touch their tenant's pause and its id only", async () => {
    await twins("took");
    await store().findOrCreateByStepKey({ ...pauseOf("took-too"), tenantId: PAUSE });
    for (const [tenantId, id] of [
      [PAUSE, "took"],
      [OTHER, "took"],
      [PAUSE, "took-too"],
    ] as const)
      await store().resolveByTenantIdAndPauseId(tenantId, id, APPROVED, MID, NO_RECIPIENTS);

    await store().markTakenByTenantIdAndPauseId(PAUSE, "took");
    await store().markSentByTenantIdAndPauseId(PAUSE, "took", NO_RECIPIENTS);

    expect(await statusOf(PAUSE, "took")).toBe(PauseStatus.Taken);
    expect(await statusOf(OTHER, "took")).toBe(PauseStatus.Resolved);
    expect(await statusOf(PAUSE, "took-too")).toBe(PauseStatus.Resolved);
    expect((await store().findByTenantIdAndPauseId(OTHER, "took"))?.isSent).toBe(false);
  });

  it("a moved deadline and a reminder are of the pause of their tenant", async () => {
    for (const tenantId of [PAUSE, OTHER])
      await store().findOrCreateByStepKey({ ...expiringPauseOf("timed"), tenantId });
    const later = new Date("2026-01-05T11:00:00.000Z");

    await store().extendByTenantIdAndPauseId(
      PAUSE,
      "timed",
      { expiresAt: later.toISOString(), previousExpiresAt: DEADLINE.toISOString() },
      NINE,
      RECIPIENTS,
    );
    const reminded = await store().remindByTenantIdAndPauseId(
      PAUSE,
      "timed",
      new Date("2026-01-05T09:40:00.000Z"),
      RECIPIENTS,
    );

    expect(reminded).toBe(false);
    expect(await store().findByTenantIdAndPauseId(OTHER, "timed")).toMatchObject({
      expiresAt: DEADLINE.toISOString(),
      remindAt: "2026-01-05T09:30:00.000Z",
    });
    expect(
      (await store().findPendingByRemindAtBefore(LATER, 10)).map((one) => one.tenantId),
    ).toEqual([OTHER]);
  });
  it("a reminder is of the pause it names, among the tenant's due ones", async () => {
    for (const id of ["due-1", "due-2"])
      await store().findOrCreateByStepKey({ ...expiringPauseOf(id), tenantId: PAUSE });

    const reminded = await store().remindByTenantIdAndPauseId(
      PAUSE,
      "due-1",
      new Date("2026-01-05T09:40:00.000Z"),
      RECIPIENTS,
    );

    expect(reminded).toBe(true);
    const waiting = await store().findPendingByRemindAtBefore(LATER, 10);
    expect(waiting.map((one) => one.pauseId).filter((id) => id.startsWith("due-"))).toEqual([
      "due-2",
    ]);
  });
});
