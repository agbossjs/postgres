import {
  StoreCallTimeoutError,
  StoreOutcomeSource,
  StoreOutcomeUnknownError,
} from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { outcomeOf } from "../../src/connection/outcome.js";

const withCode = (code: string): Error => Object.assign(new Error(`failed ${code}`), { code });

const COMMIT = { sql: "COMMIT", isInTransaction: true, timeout: 10_000 };
const WRITE = { sql: "UPDATE t SET v = 1", isInTransaction: false, timeout: 10_000 };
const IN_TRANSACTION = { sql: "UPDATE t SET v = 1", isInTransaction: true, timeout: 10_000 };
const READ = { sql: "SELECT v FROM t", isInTransaction: false, timeout: 10_000 };

const TRANSPORT = [
  withCode("08006"),
  withCode("08003"),
  withCode("08000"),
  withCode("57P01"),
  withCode("57P02"),
  withCode("40003"),
  withCode("ECONNRESET"),
  withCode("EPIPE"),
  withCode("ETIMEDOUT"),
  new Error("Connection terminated unexpectedly"),
  new Error("Connection terminated"),
];

describe("agbossjs/agboss#1017: which statement errors leave an outcome unknown", () => {
  it.each(TRANSPORT)(
    "%s while a COMMIT or a single write is in flight: unknown (transport)",
    (error) => {
      for (const statement of [COMMIT, WRITE])
        expect(outcomeOf(error, statement)).toMatchObject({
          source: StoreOutcomeSource.Transport,
          cause: error,
        });
      expect(outcomeOf(error, COMMIT)).toBeInstanceOf(StoreOutcomeUnknownError);
    },
  );

  it.each(TRANSPORT)(
    "%s on a statement inside a transaction, or on a read: known, as it is",
    (error) => {
      expect(outcomeOf(error, IN_TRANSACTION)).toBe(error);
      expect(outcomeOf(error, READ)).toBe(error);
    },
  );

  it.each(["23505", "40001", "P0001", "08001", "57P03", "25P03"])(
    "%s, the server's own answer or a connect that never got through: known, as it is",
    (code) => {
      const error = withCode(code);

      for (const statement of [COMMIT, WRITE, IN_TRANSACTION, READ])
        expect(outcomeOf(error, statement)).toBe(error);
    },
  );

  it("a command timeout of either kind is StoreCallTimeoutError (command) on every statement, reads included", () => {
    for (const error of [withCode("57014"), new Error("Query read timeout")])
      for (const statement of [COMMIT, WRITE, IN_TRANSACTION, READ])
        expect(outcomeOf(error, statement)).toMatchObject({
          code: StoreCallTimeoutError.code,
          source: StoreOutcomeSource.Command,
          timeout: 10_000,
          cause: error,
        });
  });
});
