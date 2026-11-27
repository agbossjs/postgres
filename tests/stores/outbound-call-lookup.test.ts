import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { describe, expect, it } from "vitest";
import { foundRowOf } from "../../src/stores/outbound-calls/outbound-call-lookup.js";
import { recordedPool } from "./recorded-pool.js";

/**
 * Which rows an outbound call's lookup reads, with no database (agbossjs/agboss#1317d): a step's key
 * one row by its step; a business key one row by its identity and, after a rotation of the
 * idempotency secret, a second by the digest the previous secret made — the second only when the
 * first found none, and only when there is one.
 */
const BASE = {
  scopeKey: "default:run-1",
  tenantId: "default",
  leaseExecutionId: "run-1",
  token: 1,
  idempotencyKey: "run-1:charge:1",
  name: "charge",
};
const ROW = { record: { status: "completed" } };

const lookup = async (
  fields: object,
  answers: readonly (readonly object[])[],
): Promise<{
  readonly row: unknown;
  readonly values: readonly (readonly unknown[])[];
  readonly sql: readonly string[];
}> => {
  const { pool, sent } = recordedPool(answers);
  const client = await pool.connect();
  const row = await foundRowOf(client, effectKeyForTesting(BASE, fields));
  return { row, values: sent.map(({ values }) => values), sql: sent.map(({ sql }) => sql) };
};

describe("foundRowOf", () => {
  it("a step's key is one read by its step, found or not", async () => {
    const found = await lookup({}, [[ROW]]);
    const none = await lookup({}, [[]]);

    expect(found.sql[0]).toContain("SELECT record FROM agboss_outbound_calls WHERE scope_key = $1");
    expect(found.row).toEqual(ROW);
    expect(found.values).toEqual([["default:run-1", "run-1:charge:1", "charge"]]);
    expect(none.row).toBeUndefined();
    expect(none.values).toHaveLength(1);
  });

  it("a business key with no previous digest is one read by its identity, and nothing found is none", async () => {
    const none = await lookup({ businessKey: "digest-new" }, [[]]);

    expect(none.row).toBeUndefined();
    expect(none.values).toEqual([["default", "charge", "digest-new"]]);
  });

  it("a business key found at the first read is not looked for again under the previous digest", async () => {
    const found = await lookup({ businessKey: "digest-new", previousBusinessKey: "digest-old" }, [
      [ROW],
    ]);

    expect(found.row).toEqual(ROW);
    expect(found.values).toEqual([["default", "charge", "digest-new"]]);
  });

  it("after a rotation: none under the new digest, the row under the previous one", async () => {
    const found = await lookup({ businessKey: "digest-new", previousBusinessKey: "digest-old" }, [
      [],
      [ROW],
    ]);
    const none = await lookup({ businessKey: "digest-new", previousBusinessKey: "digest-old" }, [
      [],
      [],
    ]);

    expect(found.row).toEqual(ROW);
    expect(found.values).toEqual([
      ["default", "charge", "digest-new"],
      ["default", "charge", "digest-old"],
    ]);
    expect(none.row).toBeUndefined();
    expect(none.values).toHaveLength(2);
  });
});
