import pg from "pg";
import { isClientTimeout, isCommit, isUnknownTransport, outcomeOf } from "./outcome.js";
import { StoreError } from "@agboss/core/stores";

/**
 * The command timeout of the pool's connections, in ms (agbossjs/agboss#928): `pg.Pool` hands it to
 * each client it makes with the rest of its options (`poolOptionsOf`, with `query_timeout` a margin
 * later).
 */
export interface TimedClientConfig extends pg.ClientConfig {
  readonly commandTimeout: number;
}

/** A statement given as a query config (`pg`'s carries `text`, `values`, `query_timeout`). */
type TimedQuery = object;

/**
 * How much later than the server's `statement_timeout` the client gives up on the answer: the
 * server answers first when it can, so a client-side timeout means the server is out of reach.
 */
export const CLIENT_TIMEOUT_MARGIN = 1000;

/** A `pg` query callback. */
type Answer = (error: unknown, result?: unknown) => void;

const isBegin = (sql: string): boolean => /^\s*(?:begin|start)\b/iu.test(sql);
const isEnd = (sql: string): boolean => /^\s*(?:commit|end|rollback)\b/iu.test(sql);

/** A query config; not a submittable (the driver answers one with itself, its errors as events). */
const isTimedQuery = (value: unknown): value is TimedQuery =>
  typeof value === "object" && value !== null && !("submit" in value);

/**
 * A `pg.Client` whose promise `query` reads its failure (agbossjs/agboss#928, #1017): a command
 * timeout is `StoreError.CallTimeout` (source `Command`), a connection lost under a COMMIT or a
 * single write is `StoreError.OutcomeUnknown` (source `Transport`), anything else the driver's own
 * error (`outcome.ts`). After pg's client-side timeout the connection is still stuck on the
 * statement: its socket is destroyed, so nothing queues behind it and the pool never reuses it.
 * Every store, every transaction and LangGraph's `PostgresSaver` run on these clients.
 */
export class TimedClient extends pg.Client {
  readonly #commandTimeout: number;
  #isInTransaction = false;
  #longTimeout: number | undefined;
  /** The unknown outcome this connection ended with: every later statement rejects with it. */
  #poisonedBy: StoreError.OutcomeUnknown | undefined;

  readonly #driverQuery: (...args: unknown[]) => unknown;

  constructor(config: TimedClientConfig) {
    super(config);
    this.#commandTimeout = config.commandTimeout;
    // `pg.Client.query` has overloads (callbacks, submittables) no one signature restates: the
    // client's own `query` is replaced on the instance, and the driver's runs behind it; it stays
    // replaceable as a method is (a wrapper, a test's spy)
    const driverQuery = Reflect.get(pg.Client.prototype, "query") as (
      ...args: unknown[]
    ) => unknown;
    this.#driverQuery = (...args) => Reflect.apply(driverQuery, this, args);
    Reflect.defineProperty(this, "query", {
      value: (...args: unknown[]): unknown => this.#query(args),
      configurable: true,
      writable: true,
    });
  }

  /**
   * The statements of the transaction run under `timeout` ms until it ends (a retention's delete,
   * agbossjs/agboss#928): the caller sets the server's `statement_timeout` the same way.
   */
  useLongTimeout(timeout: number): void {
    this.#longTimeout = timeout;
  }

  // a submittable or what is no statement goes to the driver as it is; the callback form is run
  // as the promise form and answered through the callback
  #query(args: unknown[]): unknown {
    const [first, second] = args;
    const last: unknown = args.at(-1);
    const callback = typeof last === "function" ? (last as Answer) : undefined;
    if (!(typeof first === "string" || isTimedQuery(first))) return this.#driverQuery(...args);
    const sql = typeof first === "string" ? first : String(Reflect.get(first, "text"));
    const values = callback !== undefined && second === last ? undefined : second;
    const run = this.#timed(this.#withTimeout(first, values), sql);
    if (callback === undefined) return run;
    run.then(
      (result) => {
        callback(null, result);
      },
      (error: unknown) => {
        callback(error);
      },
    );
    return undefined;
  }

  /** The statement under the client's limit: the transaction's long timeout's, else the pool's own. */
  #withTimeout(first: string | TimedQuery, values: unknown): unknown[] {
    const query_timeout = (this.#longTimeout ?? this.#commandTimeout) + CLIENT_TIMEOUT_MARGIN;
    const config = typeof first === "string" ? { text: first } : first;
    return [{ ...config, query_timeout }, values];
  }

  async #timed(args: unknown[], sql: string): Promise<unknown> {
    if (this.#poisonedBy !== undefined) throw this.#poisonedBy;
    const isCommitting = isCommit(sql);
    const isInTransaction = this.#isInTransaction;
    // the server's `statement_timeout` the statement runs under (the client's is a margin later)
    const timeout = this.#longTimeout ?? this.#commandTimeout;
    try {
      const result: unknown = await this.#driverQuery(...args);
      if (isBegin(sql)) this.#isInTransaction = true;
      else if (isEnd(sql)) this.#endTransaction();
      return result;
    } catch (error) {
      if (isEnd(sql)) this.#endTransaction();
      if (isClientTimeout(error)) this.connection.stream.destroy();
      const outcome = outcomeOf(error, {
        sql,
        isInTransaction: isInTransaction && !isCommitting,
        timeout,
      });
      if (isUnknownTransport(outcome)) this.#poison(outcome);
      throw outcome;
    }
  }

  /**
   * After a statement of unknown outcome the session is past trust (postgres#113): a pooler may
   * have answered for a broken server connection, the stream may be out of step. The client is
   * ended at once — `pg-pool` never hands an ending client out again, whoever releases it and how —
   * and every later statement on it (a caller's own ROLLBACK, LangGraph's `PostgresSaver`'s)
   * rejects with this outcome, never with an error that hides it.
   */
  #poison(outcome: StoreError.OutcomeUnknown): void {
    this.#poisonedBy = outcome;
    void this.end();
  }

  #endTransaction(): void {
    this.#isInTransaction = false;
    this.#longTimeout = undefined;
  }
}
