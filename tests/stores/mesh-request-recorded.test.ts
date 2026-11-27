import { describe, expect, it } from "vitest";
import { PostgresMeshRequestRepository } from "../../src/index.js";
import { keyOf } from "./mesh-fixtures.js";
import { recordedConnection } from "./recorded-pool.js";

/** What a forget answers, with no database: whether the attempt's own row was deleted. */
describe("PostgresMeshRequestRepository.deleteByKey", () => {
  it("is true when the attempt's row went, false when none did", async () => {
    const deleted = recordedConnection([[{}]]);
    const kept = recordedConnection([[]]);

    const went = await new PostgresMeshRequestRepository(deleted.connection).deleteByKey(
      keyOf("k"),
      "attempt-1",
    );
    const stayed = await new PostgresMeshRequestRepository(kept.connection).deleteByKey(
      keyOf("k"),
      "attempt-1",
    );

    expect(went).toBe(true);
    expect(stayed).toBe(false);
    expect(deleted.sent[0]?.values).toEqual(["acme", "orders-application", "k", "attempt-1"]);
  });
});
