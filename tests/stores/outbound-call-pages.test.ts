import { OutboundCallStatus, StoreClock, StoreTimeSource } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { PostgresOutboundCallRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * The paged listing's arguments (agbossjs/agboss#825) checked before any statement: a cursor is
 * the text of a page's last id, a whole number from 1 — any other text is no cursor of this store.
 */
const database = testDatabase();

const callsOf = () =>
  new PostgresOutboundCallRepository(
    connectionTo(database.url()),
    new StoreClock(StoreTimeSource.Test, new VirtualClock()),
  );

describe("findAllByTenantIdAndStatus: the cursor", () => {
  it.each(["", "0", "01", "-1", "1.5", "abc", "1 ", "12345678901234567890"])(
    "%j is no cursor of this store: a RangeError naming what to pass",
    async (after) => {
      const page = callsOf().findAllByTenantIdAndStatus({
        tenantId: "default",
        status: OutboundCallStatus.Pending,
        limit: 10,
        after,
      });

      await expect(page).rejects.toThrow(
        new RangeError("the cursor is not one this store gave: pass the next of one of its pages"),
      );
    },
  );

  it("a cursor of this store's form lists the calls after it", async () => {
    const page = await callsOf().findAllByTenantIdAndStatus({
      tenantId: "default",
      status: OutboundCallStatus.Pending,
      limit: 10,
      after: "9223372036854775807",
    });

    expect(page).toEqual({ calls: [] });
  });
});
