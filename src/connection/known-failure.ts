import pg from "pg";

/**
 * The errors of a COMMIT, or of a single write outside a transaction, that prove it did not take
 * effect (agbossjs/agboss#1017, agbossjs/postgres#113): the WHITELIST. Every other error of such a
 * statement — an unknown SQLSTATE, a connection-class or system error, a socket, TLS or stream
 * error, a framing error of the driver, anything without a code — leaves its outcome unknown.
 *
 * A server's answer proves the statement had no effect when it is an `ErrorResponse` (pg's
 * `DatabaseError`) of a class PostgreSQL raises only while the statement or the transaction is
 * still being decided, before the commit record is written (`xact.c`'s `RecordTransactionCommit`
 * writes it inside a critical section, where an ERROR is promoted to PANIC; the rare error of the
 * cleanup after it is an internal, resource or I/O one — `XX`, `53`, `58` — none listed): the
 * server then aborts the transaction (https://www.postgresql.org/docs/current/tutorial-transactions.html),
 * and for an autocommit statement that transaction is the statement's own. The codes
 * are those of https://www.postgresql.org/docs/current/errcodes-appendix.html, by class:
 * - `09` triggered_action_exception, `2F` sql_routine_exception, `38` external_routine_exception,
 *   `P0` plpgsql_error (`RAISE`, `ASSERT`): a trigger or function the statement ran (a deferred
 *   trigger at COMMIT included) raised, the transaction is aborted;
 * - `21` cardinality_violation (an `ON CONFLICT DO UPDATE` that would touch a row twice, a subquery
 *   of more than one row), `22` data_exception (a value out of range, invalid text, division by
 *   zero), `44` with_check_option_violation: the executor refused a row, the statement is aborted;
 * - `23` integrity_constraint_violation: a constraint refused a row — at COMMIT a deferred one
 *   (https://www.postgresql.org/docs/current/sql-set-constraints.html: checked "at the end of the
 *   transaction"), the transaction is rolled back;
 * - `25` invalid_transaction_state: the statement is refused for the state of its transaction
 *   (`25P02` in_failed_sql_transaction: "commands ignored until end of transaction block"; `25006`
 *   read-only). NOT `25P03` idle_in_transaction_session_timeout and `25P04` transaction_timeout
 *   (https://www.postgresql.org/docs/current/runtime-config-client.html): they end the session from
 *   a timer, and PostgreSQL 17's `transaction_timeout` can be pending when `CommitTransaction`
 *   disables its alarm, so its FATAL may come after the commit record is durable;
 * - `40` transaction_rollback — `40000`, `40001` serialization_failure (at COMMIT, SERIALIZABLE's
 *   check, https://www.postgresql.org/docs/current/transaction-iso.html), `40002`, `40P01`
 *   deadlock_detected: the class's name is the server's statement that it rolled back. NOT `40003`
 *   statement_completion_unknown: its name says the opposite;
 * - `42` syntax_error_or_access_rule_violation (a syntax error, an undefined table, a missing
 *   privilege, `42P06` duplicate_schema of a racing `CREATE SCHEMA`): refused at parse, analysis or
 *   the permission check, before the statement ran.
 * Only with severity `ERROR`: every abort above is an `ERROR`, the statement's or the transaction's;
 * a `FATAL` or `PANIC` ends the session (a pooler's synthetic error is `FATAL` too) and is not the
 * server's word that the transaction rolled back. And only for one statement: a `CALL` or a `DO`
 * may `COMMIT` inside itself before it raises (https://www.postgresql.org/docs/current/plpgsql-transactions.html),
 * and so may a string of several statements, so their server error is unknown too.
 * Not listed, so unknown: `08` connection_exception (`08007` transaction_resolution_unknown, `08P01`
 * protocol_violation — what a pooler answers when its server connection broke), `53`
 * insufficient_resources (`53100` disk_full, `53200` out_of_memory: a WAL flush at commit may have
 * reached the disk), `57` operator_intervention (`57P01`… the session ended under the statement;
 * `57014` is a command timeout, read before this), `58` system_error (`58030` io_error), `XX`
 * internal_error (`XX000`, a pooler's "server connection closed unexpectedly"), every other class
 * (`54`, `55`, `F0`, `HV`, …): when unsure, unknown.
 */
const KNOWN_CLASSES: ReadonlySet<string> = new Set([
  "09",
  "21",
  "22",
  "23",
  "25",
  "2F",
  "38",
  "40",
  "42",
  "44",
  "P0",
]);

/** The codes of a known class whose error does not prove the statement had no effect. */
const UNKNOWN_IN_KNOWN_CLASS: ReadonlySet<string> = new Set(["40003", "25P03", "25P04"]);

/** A SQLSTATE: five digits or upper-case letters (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
const SQLSTATE = /^[0-9A-Z]{5}$/u;

/**
 * pg's errors of a statement it never wrote to the socket (pg 8 `Client.query`): the client lost
 * its connection before (`_queryable` false), or was ended (`_ending`). Compared whole: pg-pool's
 * "Connection terminated due to connection timeout" and the like are not among them.
 */
const NEVER_SENT_MESSAGES: ReadonlySet<string> = new Set([
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
]);

/** Whether `error` is the server's answer that it aborted the statement or its transaction. */
export function isServerAbort(error: unknown): boolean {
  if (!(error instanceof pg.DatabaseError)) return false;
  const code = error.code;
  return (
    error.severity === "ERROR" &&
    typeof code === "string" &&
    SQLSTATE.test(code) &&
    KNOWN_CLASSES.has(code.slice(0, 2)) &&
    !UNKNOWN_IN_KNOWN_CLASS.has(code)
  );
}

/** Whether pg refused `error`'s statement before it wrote a byte of it. */
export const isNeverSent = (error: unknown): boolean =>
  error instanceof Error && NEVER_SENT_MESSAGES.has(error.message);

/** A statement that may commit inside itself: a procedure, an anonymous block. */
const COMMITS_INSIDE = /^\s*(?:call|do)\b/iu;

/** Whether `sql` is one statement that cannot commit inside itself (trailing `;` and space aside). */
export const isOneStatement = (sql: string): boolean =>
  !COMMITS_INSIDE.test(sql) && !sql.replace(/[\s;]+$/u, "").includes(";");

/** Whether `error` proves `sql`, a COMMIT or a single write, did not take effect (the whitelist). */
export const isKnownFailure = (error: unknown, sql: string): boolean =>
  isNeverSent(error) || (isOneStatement(sql) && isServerAbort(error));
