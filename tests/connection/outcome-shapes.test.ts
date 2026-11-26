import { StoreOutcomeSource, StoreError } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import {
  type FailedStatement,
  isLostConnection,
  isTransportError,
  outcomeOf,
  operationOf,
} from "../../src/connection/outcome.js";

const withCode = (code: string): Error => Object.assign(new Error(`failed ${code}`), { code });

const statement = (sql: string, isInTransaction: boolean): FailedStatement => ({
  sql,
  isInTransaction,
  timeout: 10_000,
});

describe("agbossjs/agboss#1213: what a failed statement is called", () => {
  it("operationOf: the first three words, whitespace collapsed to one space, trimmed", () => {
    expect(operationOf("UPDATE t SET v = 1")).toBe("UPDATE t SET");
    expect(operationOf("  \n UPDATE   tbl\n\tSET v = 1 WHERE x")).toBe("UPDATE tbl SET");
    expect(operationOf("COMMIT")).toBe("COMMIT");
    expect(operationOf("a b")).toBe("a b");
  });

  it("operationOf: no more than three words", () => {
    expect(operationOf("a b c d e")).toBe("a b c");
  });

  it("operationOf: at most 60 characters", () => {
    const word = "w".repeat(30);

    expect(operationOf(`${word} ${word} ${word}`)).toBe(`${word} ${"w".repeat(29)}`);
    expect(operationOf(`${word} ${"w".repeat(29)}`)).toHaveLength(60);
  });

  it("a command timeout names the connection, the operation and the timeout", () => {
    const error = outcomeOf(withCode("57014"), statement("UPDATE   t SET v = 1", false));

    expect(error).toBeInstanceOf(StoreError.CallTimeout);
    expect(error).toMatchObject({
      store: "PostgresConnection",
      operation: "UPDATE t SET",
      timeout: 10_000,
      source: StoreOutcomeSource.Command,
    });
  });

  it("an unknown transport outcome names the connection and the operation", () => {
    const error = outcomeOf(withCode("ECONNRESET"), statement("DELETE   FROM t WHERE 1", false));

    expect(error).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(error).toMatchObject({
      store: "PostgresConnection",
      operation: "DELETE FROM t",
      source: StoreOutcomeSource.Transport,
    });
  });
});

describe("agbossjs/agboss#1213: the statement's own words decide whether it may have taken effect", () => {
  const lost = withCode("ECONNRESET");

  it.each(["commit", "  COMMIT", "\n\tEnd", " end transaction", "COMMIT PREPARED 'x'"])(
    "%j inside a transaction is a COMMIT: unknown",
    (sql) => {
      expect(outcomeOf(lost, statement(sql, true))).toBeInstanceOf(StoreError.OutcomeUnknown);
    },
  );

  it.each([
    "UPDATE t SET x = 1 -- end",
    "SELECT commit FROM t",
    "xcommit",
    "recommit",
    "ending",
    "committed",
    "ROLLBACK TO end",
  ])("%j inside a transaction is not a COMMIT: known", (sql) => {
    expect(outcomeOf(lost, statement(sql, true))).toBe(lost);
  });

  it.each([
    "SELECT 1",
    "  select 1",
    "\n\tSHOW x",
    " rollback",
    "\nBEGIN",
    " set x = 1",
    " DISCARD ALL",
  ])("%j outside a transaction has no effect, whatever whitespace leads it: known", (sql) => {
    expect(outcomeOf(lost, statement(sql, false))).toBe(lost);
  });

  it.each([
    "xselect 1",
    "selected",
    "reselect",
    "insert into t values (1)",
    "WITH x AS (SELECT 1) DELETE FROM t",
  ])("%j outside a transaction may be a write: unknown", (sql) => {
    expect(outcomeOf(lost, statement(sql, false))).toBeInstanceOf(StoreError.OutcomeUnknown);
  });
});

describe("agbossjs/agboss#1213: which values are a transport error", () => {
  it("a value that is not an Error is none, whatever it carries", () => {
    for (const value of [
      null,
      undefined,
      "Connection terminated",
      { message: "Connection terminated" },
      { code: "ECONNRESET", message: "x" },
      42,
    ])
      expect(isTransportError(value)).toBe(false);
  });

  it("a code that is not a string matches nothing", () => {
    expect(isTransportError(Object.assign(new Error("x"), { code: 8006 }))).toBe(false);
    expect(isTransportError(Object.assign(new Error("x"), { code: ["ECONNRESET"] }))).toBe(false);
  });

  it("an Error with another code or message is none", () => {
    expect(isTransportError(withCode("23505"))).toBe(false);
    expect(isTransportError(new Error("boom"))).toBe(false);
    expect(isTransportError(new Error("the Connection terminated"))).toBe(false);
  });

  it("an AggregateError is one when any of its errors is, not only when all are", () => {
    const other = new Error("boom");

    expect(isTransportError(new AggregateError([withCode("ECONNRESET")]))).toBe(true);
    expect(isTransportError(new AggregateError([other, withCode("ECONNRESET")]))).toBe(true);
    expect(isTransportError(new AggregateError([withCode("EPIPE"), other]))).toBe(true);
    expect(isTransportError(new AggregateError([other, withCode("23505")]))).toBe(false);
    expect(isTransportError(new AggregateError([]))).toBe(false);
  });

  it("a mixed AggregateError on a write is an unknown outcome", () => {
    const error = new AggregateError([new Error("boom"), withCode("ETIMEDOUT")]);

    expect(outcomeOf(error, statement("UPDATE t SET v = 1", false))).toBeInstanceOf(
      StoreError.OutcomeUnknown,
    );
    expect(isLostConnection(error)).toBe(true);
  });

  it("isLostConnection looks at the cause too, and at nothing that is not an Error", () => {
    expect(isLostConnection(new Error("x", { cause: withCode("EPIPE") }))).toBe(true);
    expect(isLostConnection(new Error("x", { cause: new Error("Query read timeout") }))).toBe(true);
    expect(isLostConnection(new Error("x", { cause: withCode("23505") }))).toBe(false);
    expect(isLostConnection({ cause: withCode("EPIPE") })).toBe(false);
    expect(isLostConnection(null)).toBe(false);
  });
});
