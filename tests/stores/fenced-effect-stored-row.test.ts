import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { describe, expect, it } from "vitest";
import { storedRowOf } from "../../src/stores/postgres-fenced-effect.repository.js";
import { recordedPool } from "./recorded-pool.js";

/**
 * Which rows a fenced effect's replay reads, with no database (agbossjs/agboss#508, #1317d): a
 * step's key one row by its step; a business key one row by its identity under the advisory lock,
 * and — after a rotation of the idempotency secret — a second by the previous digest, only when the
 * first found none and only when there is a previous one.
 */
const BASE = {
  scopeKey: "default:run-1",
  tenantId: "default",
  leaseExecutionId: "run-1",
  token: 1,
  idempotencyKey: "run-1:charge:1",
  name: "charge",
};
const ROW = { token: 1, result: "{}", fingerprint: "f", origin: null };
const isRead = (sql: string): boolean => sql.includes("agboss_fenced_effect");

const read = async (fields: object, answers: readonly (readonly object[])[]) => {
  const { pool, sent } = recordedPool(answers);
  const client = await pool.connect();
  const row = await storedRowOf(client, effectKeyForTesting(BASE, fields));
  return { row, reads: sent.filter(({ sql }) => isRead(sql)), sent };
};

describe("storedRowOf", () => {
  it("a step's key is one read by its step", async () => {
    const found = await read({}, [[ROW]]);

    expect(found.row).toEqual(ROW);
    expect(found.reads.map(({ values }) => values)).toEqual([
      ["default:run-1", "run-1:charge:1", "charge"],
    ]);
  });

  it("a business key is read by its identity, found: no second read", async () => {
    // the first answer is the advisory lock's, the second the row
    const found = await read({ businessKey: "d-new", previousBusinessKey: "d-old" }, [[{}], [ROW]]);

    expect(found.row).toEqual(ROW);
    expect(found.reads.map(({ values }) => values)).toEqual([["default", "charge", "d-new"]]);
    // the key's own identity is what the advisory lock is taken on, before any read
    const lock = found.sent.find(({ sql }) => sql.includes("pg_advisory_xact_lock"));
    expect(lock?.values).toEqual([JSON.stringify(["default", "charge", "d-new"])]);
    const at = (needle: string): number => found.sent.findIndex(({ sql }) => sql.includes(needle));
    expect(at("pg_advisory_xact_lock")).toBeLessThan(at("agboss_fenced_effect_business_results"));
  });

  it("none under the new digest and none previous: one read, no row", async () => {
    const none = await read({ businessKey: "d-new" }, [[{}], []]);

    expect(none.row).toBeUndefined();
    expect(none.reads).toHaveLength(1);
  });

  it("after a rotation: none under the new digest, the row under the previous one", async () => {
    const rotated = await read({ businessKey: "d-new", previousBusinessKey: "d-old" }, [
      [{}],
      [],
      [ROW],
    ]);
    const neither = await read({ businessKey: "d-new", previousBusinessKey: "d-old" }, [
      [{}],
      [],
      [],
    ]);

    expect(rotated.row).toEqual(ROW);
    expect(rotated.reads.map(({ values }) => values)).toEqual([
      ["default", "charge", "d-new"],
      ["default", "charge", "d-old"],
    ]);
    expect(neither.row).toBeUndefined();
    expect(neither.reads).toHaveLength(2);
  });
});
