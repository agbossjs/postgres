import { StoreOutcomeSource, StoreError, isStoreOutcomeUnknown } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { isLostConnection, outcomeOf } from "../../src/connection/outcome.js";

const withCode = (code: string): Error => Object.assign(new Error(`failed ${code}`), { code });

const COMMIT = { sql: "COMMIT", isInTransaction: true, timeout: 10_000 };
const WRITE = { sql: "UPDATE t SET v = 1", isInTransaction: false, timeout: 10_000 };
const IN_TRANSACTION = { sql: "UPDATE t SET v = 1", isInTransaction: true, timeout: 10_000 };
const READ = { sql: "SELECT v FROM t", isInTransaction: false, timeout: 10_000 };

/** Lost connections, sockets, TLS, streams and pg's framing: each unknown at a COMMIT or a write. */
const LOST = [
  ...[
    ...["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "ENETRESET", "ENETUNREACH"],
    ...["EHOSTUNREACH", "EHOSTDOWN", "ECONNREFUSED", "EPROTO", "EIO", "ECANCELED"],
    ...["ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"],
    ...["ERR_SOCKET_CLOSED", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC"],
    ...["ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC", "ERR_TLS_CERT_ALTNAME_INVALID"],
    ...["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "SOMETHING_NEW"],
  ].map(withCode),
  // SQLSTATEs on an error that is not the server's answer (a driver's or a wrapper's)
  ...["08006", "08003", "08000", "08007", "08P01", "57P01", "57P02", "40003", "XX000"].map(
    withCode,
  ),
  new Error("Connection terminated unexpectedly"),
  new Error("Connection terminated"),
  new Error("Connection terminated due to connection timeout"),
  new Error("Received unexpected commandComplete message from backend."),
  new Error("Client has encountered a connection error and is not queryable, again"),
  new Error("client was closed and is not queryable"),
  new TypeError("Converting circular structure to JSON"),
  new AggregateError([withCode("ECONNREFUSED")]),
  new Error("boom"),
];

describe("agbossjs/agboss#1017, agbossjs/postgres#113: which statement errors leave an outcome unknown", () => {
  it.each(LOST)(
    "%s while a COMMIT or a single write is in flight: unknown (transport)",
    (error) => {
      for (const statement of [COMMIT, WRITE])
        expect(outcomeOf(error, statement)).toMatchObject({
          source: StoreOutcomeSource.Transport,
          cause: error,
        });
      expect(outcomeOf(error, COMMIT)).toBeInstanceOf(StoreError.OutcomeUnknown);
    },
  );

  it.each(LOST)(
    "%s on a statement inside a transaction, or on a read: known, as it is",
    (error) => {
      expect(outcomeOf(error, IN_TRANSACTION)).toBe(error);
      expect(outcomeOf(error, READ)).toBe(error);
    },
  );

  it.each([null, undefined, "Connection terminated", 42, { code: "23505" }])(
    "%j, a value that is no Error, at a COMMIT or a write: unknown",
    (value) => {
      for (const statement of [COMMIT, WRITE])
        expect(outcomeOf(value, statement)).toBeInstanceOf(StoreError.OutcomeUnknown);
      expect(outcomeOf(value, IN_TRANSACTION)).toBe(value);
    },
  );

  it.each([
    "Client has encountered a connection error and is not queryable",
    "Client was closed and is not queryable",
  ])("pg's %j (the statement was never sent): known everywhere", (message) => {
    const error = new Error(message);

    for (const statement of [COMMIT, WRITE, IN_TRANSACTION, READ])
      expect(outcomeOf(error, statement)).toBe(error);
  });

  it("a command timeout of either kind is StoreError.CallTimeout (command) on every statement, reads included", () => {
    for (const error of [withCode("57014"), new Error("Query read timeout")])
      for (const statement of [COMMIT, WRITE, IN_TRANSACTION, READ])
        expect(outcomeOf(error, statement)).toMatchObject({
          code: StoreError.CallTimeout.code,
          source: StoreOutcomeSource.Command,
          timeout: 10_000,
          cause: error,
        });
  });
});

describe("agbossjs/postgres#113: which errors lose the connection (not given back, not rolled back on)", () => {
  it.each([
    "08006",
    "08003",
    "08000",
    "57P01",
    "57P02",
    "40003",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
  ])("%s inside a transaction (known) loses the connection, itself or as the cause", (code) => {
    const error = outcomeOf(withCode(code), IN_TRANSACTION);

    expect(isStoreOutcomeUnknown(error)).toBe(false);
    expect(isLostConnection(error)).toBe(true);
    expect(isLostConnection(new Error("x", { cause: error }))).toBe(true);
  });

  it.each(["08P01", "57P03", "XX000", "", "ECONNABORTED"])(
    "%s inside a transaction is not on the list of lost connections",
    (code) => {
      expect(isLostConnection(withCode(code))).toBe(false);
    },
  );

  it("a COMMIT or write of unknown outcome is a lost connection; a command timeout or another source is not", () => {
    const unknown = outcomeOf(withCode("XX000"), COMMIT);
    const timeout = outcomeOf(withCode("57014"), COMMIT);
    const other = new StoreError.OutcomeUnknown({
      store: "PostgresConnection",
      operation: "COMMIT",
      source: StoreOutcomeSource.Framework,
    });

    expect(unknown).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(isLostConnection(unknown)).toBe(true);
    expect(isLostConnection(timeout)).toBe(false);
    expect(isLostConnection(other)).toBe(false);
  });
});
