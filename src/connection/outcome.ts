import {
  StoreCallTimeoutError,
  StoreOutcomeSource,
  StoreOutcomeUnknownError,
} from "@agboss/core/stores";
import type { Milliseconds } from "@agboss/core/units";

/**
 * Which errors of a statement leave its outcome unknown (agbossjs/agboss#928, #1017). A statement
 * that did not answer, or whose answer was lost, may have taken effect: the framework never takes
 * it as done and never as not done — under a lease the holder hands the tree over.
 *
 * - a command timeout (the server's `statement_timeout`, SQLSTATE 57014, or pg's client-side
 *   `query_timeout`, "Query read timeout"): unknown, whatever the statement — `source: Command`;
 * - a transport error (a connection lost: SQLSTATE class 08, 57P01, 57P02, 40003, ECONNRESET, EPIPE,
 *   ETIMEDOUT, pg's "Connection terminated") while a COMMIT or a single-statement write outside a
 *   transaction is in flight: unknown — `source: Transport`;
 * - the same error on a statement inside a transaction before its COMMIT: the session died and the
 *   transaction rolled back, known; on a read (no effect), known;
 * - any other error — the server's own answer (23505, 40001, P0001, …), a connect that never got
 *   through (08001, 57P03, the connect timeout), a pool-slot wait: known, rethrown as it is.
 */

const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "08006",
  "08003",
  "08000",
  "57P01",
  "57P02",
  "40003",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

const CLIENT_TIMEOUT_MESSAGE = "Query read timeout";

const STATEMENT_TIMEOUT_CODE = "57014";

/** The `code` of a driver error, when it has one. */
const codeOf = (error: unknown): string | undefined => {
  const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : undefined;
};

/** pg's own client-side timeout (`query_timeout`): the connection is stuck on the statement. */
export const isClientTimeout = (error: unknown): boolean =>
  error instanceof Error && error.message === CLIENT_TIMEOUT_MESSAGE;

/** The server cancelled the statement at `statement_timeout`. */
export const isStatementTimeout = (error: unknown): boolean =>
  codeOf(error) === STATEMENT_TIMEOUT_CODE;

/** A command timeout of either kind. */
export const isCommandTimeout = (error: unknown): boolean =>
  isClientTimeout(error) || isStatementTimeout(error);

/** A connection lost under a statement (the answer may never have been heard). */
export function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = codeOf(error);
  return (
    (code !== undefined && TRANSPORT_CODES.has(code)) ||
    error.message.startsWith("Connection terminated") ||
    (error instanceof AggregateError && error.errors.some(isTransportError))
  );
}

/** A statement that is not a write: a read, or a session command with no effect on the data. */
const NO_EFFECT = /^\s*(?:select|show|listen|unlisten|set|reset|begin|start|rollback|discard)\b/iu;

/** Whether `sql` may change data (when unsure, it may). */
export const isWrite = (sql: string): boolean => !NO_EFFECT.test(sql);

/** Whether `sql` is a COMMIT. */
export const isCommit = (sql: string): boolean => /^\s*(?:commit|end)\b/iu.test(sql);

/** The first words of `sql`, to name the operation in an error. */
export const operationOf = (sql: string): string =>
  sql.trim().split(/\s+/u).slice(0, 3).join(" ").slice(0, 60);

/** What a statement was when it failed. */
export interface FailedStatement {
  readonly sql: string;
  /** Whether its connection was inside an explicit transaction. */
  readonly isInTransaction: boolean;
  /** The command timeout the statement ran under, in ms. */
  readonly timeout: number;
}

/** `error` as it is, or as the error of unknown outcome it is read as. */
export function outcomeOf(error: unknown, statement: FailedStatement): unknown {
  const operation = operationOf(statement.sql);
  if (isCommandTimeout(error))
    return new StoreCallTimeoutError({
      store: "PostgresConnection",
      operation,
      timeout: statement.timeout as Milliseconds,
      source: StoreOutcomeSource.Command,
      cause: error,
    });
  const isEffectful =
    isCommit(statement.sql) || (!statement.isInTransaction && isWrite(statement.sql));
  if (isTransportError(error) && isEffectful)
    return new StoreOutcomeUnknownError({
      store: "PostgresConnection",
      operation,
      source: StoreOutcomeSource.Transport,
      cause: error,
    });
  return error;
}

/** Whether `error` leaves its connection stuck or gone (a client-side timeout, a transport error). */
export function isLostConnection(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return (
    isClientTimeout(error) ||
    isClientTimeout(cause) ||
    isTransportError(error) ||
    isTransportError(cause)
  );
}
