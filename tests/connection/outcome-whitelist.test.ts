/**
 * agbossjs/postgres#113 (agbossjs/agboss#1017's whitelist rule): every SQLSTATE class of
 * PostgreSQL's appendix (https://www.postgresql.org/docs/current/errcodes-appendix.html), every
 * Node socket, TLS and stream code, and pg's own messages, at a COMMIT, at a single write outside
 * a transaction, inside a transaction and on a read. Only a server abort of a whitelisted class,
 * or a statement pg never sent, is known at a COMMIT or a write; everything else is unknown there.
 * Flipping any row's class or code in `known-failure.ts` turns its rows red.
 */
import { StoreOutcomeSource, StoreError } from "@agboss/core/stores";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { type FailedStatement, outcomeOf } from "../../src/connection/outcome.js";

/** What the server answers: pg's `DatabaseError` of an `ErrorResponse`, with `code`. */
function serverError(code: unknown, severity = "ERROR"): pg.DatabaseError {
  const error = new pg.DatabaseError(`server says ${String(code)}`, 0, "error");
  Reflect.set(error, "code", code);
  error.severity = severity;
  return error;
}

const COMMIT: FailedStatement = { sql: "COMMIT", isInTransaction: true, timeout: 10_000 };
const END: FailedStatement = { sql: "END", isInTransaction: true, timeout: 10_000 };
const WRITE: FailedStatement = {
  sql: "UPDATE t SET v = 1",
  isInTransaction: false,
  timeout: 10_000,
};
const WITH_WRITE: FailedStatement = {
  sql: "WITH x AS (DELETE FROM t RETURNING 1) SELECT 1",
  isInTransaction: false,
  timeout: 10_000,
};
const IN_TRANSACTION: FailedStatement = {
  sql: "UPDATE t SET v = 1",
  isInTransaction: true,
  timeout: 10_000,
};
const READ: FailedStatement = { sql: "SELECT v FROM t", isInTransaction: false, timeout: 10_000 };

const EFFECTFUL = [COMMIT, END, WRITE, WITH_WRITE];

/** The whitelisted classes: a server abort of any of their codes proves nothing was applied. */
const KNOWN: readonly string[] = [
  // 09 triggered action exception
  "09000",
  // 21 cardinality violation
  "21000",
  // 22 data exception
  ...["22000", "22001", "22003", "22007", "22012", "22P02", "22P05"],
  // 23 integrity constraint violation (deferred, at COMMIT)
  ...["23000", "23001", "23502", "23503", "23505", "23514", "23P01"],
  // 25 invalid transaction state
  ...["25000", "25001", "25006", "25P01", "25P02"],
  // 2F SQL routine exception
  ...["2F000", "2F005"],
  // 38 external routine exception
  ...["38000", "38001"],
  // 40 transaction rollback, but 40003
  ...["40000", "40001", "40002", "40P01"],
  // 42 syntax error or access rule violation
  ...["42000", "42501", "42601", "42703", "42P01", "42P06"],
  // 44 WITH CHECK OPTION violation
  "44000",
  // P0 PL/pgSQL error
  ...["P0000", "P0001", "P0002", "P0003", "P0004"],
];

/** Every other class (and 40003): a server error that does not prove the statement had no effect. */
const UNKNOWN: readonly string[] = [
  ...["00000", "01000", "02000", "03000"],
  // 08 connection exception, every code
  ...["08000", "08001", "08003", "08004", "08006", "08007", "08P01"],
  ...["0A000", "0B000", "0F000", "0F001", "0L000", "0LP01", "0P000", "0Z000", "0Z002"],
  ...["20000", "24000", "26000", "27000", "28000", "28P01", "2B000", "2BP01", "2D000"],
  ...["34000", "39000", "39001", "39P01", "3B000", "3B001", "3D000", "3F000"],
  // 40003 statement completion unknown; 25P03 / 25P04 end the session by a timer that can fire
  // after the commit record (PostgreSQL 17 transaction_timeout)
  ...["40003", "25P03", "25P04"],
  // 53 insufficient resources
  ...["53000", "53100", "53200", "53300", "53400"],
  ...["54000", "54001", "55000", "55006", "55P03"],
  // 57 operator intervention (57014 is a command timeout: outcome.test.ts)
  ...["57000", "57P01", "57P02", "57P03", "57P04", "57P05"],
  // 58 system error
  ...["58000", "58030", "58P01", "58P02"],
  ...["72000", "F0000", "F0001", "HV000", "HV00N"],
  // XX internal error (a pooler's "server connection closed unexpectedly")
  ...["XX000", "XX001", "XX002"],
];

describe("agbossjs/postgres#113: a server abort of a whitelisted class is known everywhere", () => {
  it.each(KNOWN)(
    "%s at a COMMIT, a single write, inside a transaction, on a read: known",
    (code) => {
      const error = serverError(code);

      for (const statement of [...EFFECTFUL, IN_TRANSACTION, READ])
        expect(outcomeOf(error, statement)).toBe(error);
    },
  );

  it.each(["23505", "40001", "40P01", "25P02", "P0001", "42601"])(
    "%s as FATAL or PANIC (a pooler's synthetic error, a session ended) at a COMMIT or a write: unknown",
    (code) => {
      for (const severity of ["FATAL", "PANIC", "", "error"])
        for (const statement of EFFECTFUL)
          expect(outcomeOf(serverError(code, severity), statement)).toBeInstanceOf(
            StoreError.OutcomeUnknown,
          );
    },
  );

  it("a server abort without a severity, at a COMMIT: unknown", () => {
    const error = serverError("23505");
    error.severity = undefined;

    expect(outcomeOf(error, COMMIT)).toBeInstanceOf(StoreError.OutcomeUnknown);
  });
});

describe("agbossjs/postgres#113: any other server error at a COMMIT or a write is unknown", () => {
  it.each(UNKNOWN)("%s at a COMMIT or a single write: unknown (transport)", (code) => {
    const error = serverError(code);

    for (const statement of EFFECTFUL) {
      const read = outcomeOf(error, statement);
      expect(read).toBeInstanceOf(StoreError.OutcomeUnknown);
      expect(read).toMatchObject({ source: StoreOutcomeSource.Transport, cause: error });
    }
  });

  it.each(UNKNOWN)("%s inside a transaction or on a read: known, as it is", (code) => {
    const error = serverError(code);

    expect(outcomeOf(error, IN_TRANSACTION)).toBe(error);
    expect(outcomeOf(error, READ)).toBe(error);
  });

  it.each([
    ["no code (pg's 'received invalid response' of a garbled answer)", undefined],
    ["a number", 23505],
    ["four characters", "2350"],
    ["six characters", "235050"],
    ["a lower-case code", "p0001"],
    ["a whitelisted class with a space", "23 05"],
    ["an empty code", ""],
  ])("a server error whose code is %s, at a COMMIT: unknown", (_name, code) => {
    expect(outcomeOf(serverError(code), COMMIT)).toBeInstanceOf(StoreError.OutcomeUnknown);
  });

  it("a whitelisted code on an error that is not the server's answer, at a COMMIT: unknown", () => {
    for (const code of ["23505", "40001", "40P01", "25P02", "42P06"]) {
      const error = Object.assign(new Error(`not the server ${code}`), { code });
      expect(outcomeOf(error, COMMIT)).toBeInstanceOf(StoreError.OutcomeUnknown);
      expect(outcomeOf(error, WRITE)).toBeInstanceOf(StoreError.OutcomeUnknown);
    }
  });
});

describe("agbossjs/postgres#113: a statement that can commit inside itself is never trusted on the server's word", () => {
  const write = (sql: string): FailedStatement => ({
    sql,
    isInTransaction: false,
    timeout: 10_000,
  });

  it.each([
    "CALL pay(1)",
    "  call pay()",
    "DO $$ BEGIN COMMIT; RAISE EXCEPTION 'x'; END $$",
    "BEGIN; INSERT INTO t VALUES (1); COMMIT; SELECT 1/0",
    "INSERT INTO t VALUES (1); INSERT INTO t VALUES (1)",
  ])(
    "%j fails with a whitelisted server abort: unknown (an inner COMMIT may have applied)",
    (sql) => {
      for (const code of ["23505", "P0001", "22012"])
        expect(outcomeOf(serverError(code), write(sql))).toBeInstanceOf(StoreError.OutcomeUnknown);
    },
  );

  it.each([
    "INSERT INTO t VALUES (1);",
    "INSERT INTO t VALUES (1) ;  \n",
    "UPDATE called SET v = 1",
  ])("%j is one statement: its server abort stays known", (sql) => {
    const error = serverError("23505");

    expect(outcomeOf(error, write(sql))).toBe(error);
  });

  it("a CALL pg never sent stays known", () => {
    const error = new Error("Client was closed and is not queryable");

    expect(outcomeOf(error, write("CALL pay()"))).toBe(error);
  });
});
