import { Duplex } from "node:stream";
import pg from "pg";
import { StoreOutcomeUnknownError } from "@agboss/core/stores";
import { isClientTimeout, isCommit, isUnknownTransport, outcomeOf } from "./outcome.js";

/**
 * The command timeout of the pool's connections, in ms (agbossjs/agboss#928): `pg.Pool` hands it to
 * each client it makes with the rest of its options.
 */
export interface TimedClientConfig extends pg.ClientConfig {
  readonly commandTimeout?: number;
}

/** A statement's own limits (`pg`'s query config carries `query_timeout`). */
interface TimedQuery {
  readonly text: string;
  readonly query_timeout?: number;
}

/**
 * How much later than the server's `statement_timeout` the client gives up on the answer: the
 * server answers first when it can, so a client-side timeout means the server is out of reach.
 */
export const CLIENT_TIMEOUT_MARGIN = 1000;

/** A `pg` query callback. */
type Answer = (error: unknown, result?: unknown) => void;

const isBegin = (sql: string): boolean => /^\s*(?:begin|start)\b/iu.test(sql);
const isEnd = (sql: string): boolean => /^\s*(?:commit|end|rollback)\b/iu.test(sql);

const isTimedQuery = (value: unknown): value is TimedQuery =>
  typeof value === "object" && value !== null && "text" in value && typeof value.text === "string";

/**
 * A `pg.Client` whose promise `query` reads its failure (agbossjs/agboss#928, #1017): a command
 * timeout is `StoreCallTimeoutError` (source `Command`), a connection lost under a COMMIT or a
 * single write is `StoreOutcomeUnknownError` (source `Transport`), anything else the driver's own
 * error (`outcome.ts`). After pg's client-side timeout the connection is still stuck on the
 * statement: its socket is destroyed, so nothing queues behind it and the pool never reuses it.
 * Every store, every transaction and LangGraph's `PostgresSaver` run on these clients.
 */
export class TimedClient extends pg.Client {
  readonly #commandTimeout: number | undefined;
  #isInTransaction = false;
  #longTimeout: number | undefined;
  /** The unknown outcome this connection ended with: every later statement rejects with it. */
  #poisonedBy: StoreOutcomeUnknownError | undefined;

  readonly #driverQuery: (...args: unknown[]) => unknown;

  constructor(config?: TimedClientConfig) {
    super(config);
    this.#commandTimeout = config?.commandTimeout;
    // `pg.Client.query` has overloads (callbacks, submittables) no one signature restates: the
    // client's own `query` is replaced on the instance, and the driver's runs behind it
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

  // a submittable goes to the driver as it is; the callback form (`pg.Pool.query` uses it) is run
  // as the promise form and answered through the callback
  #query(args: unknown[]): unknown {
    const [first, second] = args;
    const last: unknown = args.at(-1);
    const callback = typeof last === "function" ? (last as Answer) : undefined;
    if (!(typeof first === "string" || isTimedQuery(first))) return this.#driverQuery(...args);
    const sql = typeof first === "string" ? first : first.text;
    const values = callback !== undefined && second === last ? undefined : second;
    const run = this.#timed(this.#withLongTimeout(first, values), sql);
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

  #withLongTimeout(first: unknown, second: unknown): unknown[] {
    if (this.#longTimeout === undefined) return second === undefined ? [first] : [first, second];
    const query_timeout = this.#longTimeout + CLIENT_TIMEOUT_MARGIN;
    if (typeof first === "string") return [{ text: first, values: second, query_timeout }];
    return [{ ...(first as object), query_timeout }];
  }

  async #timed(args: unknown[], sql: string): Promise<unknown> {
    if (this.#poisonedBy !== undefined) throw this.#poisonedBy;
    const isCommitting = isCommit(sql);
    const isInTransaction = this.#isInTransaction;
    try {
      const result: unknown = await this.#driverQuery(...args);
      if (isBegin(sql)) this.#isInTransaction = true;
      else if (isEnd(sql)) this.#endTransaction();
      return result;
    } catch (error) {
      if (isEnd(sql)) this.#endTransaction();
      if (isClientTimeout(error)) this.#destroySocket();
      const outcome = outcomeOf(error, {
        sql,
        isInTransaction: isInTransaction && !isCommitting,
        timeout: this.#timeoutOf(args),
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
  #poison(outcome: StoreOutcomeUnknownError): void {
    this.#poisonedBy = outcome;
    void this.end();
  }

  #timeoutOf(args: unknown[]): number {
    const [first] = args;
    const own = isTimedQuery(first) ? first.query_timeout : undefined;
    const parameters: unknown = Reflect.get(this, "connectionParameters");
    const readTimeout: unknown = own ?? Reflect.get(Object(parameters), "query_timeout");
    return typeof readTimeout === "number" && readTimeout > CLIENT_TIMEOUT_MARGIN
      ? readTimeout - CLIENT_TIMEOUT_MARGIN
      : (this.#commandTimeout ?? 0);
  }

  /** The connection is stuck on the statement: ends its socket, so nothing queues behind it. */
  #destroySocket(): void {
    const connection: unknown = Reflect.get(this, "connection");
    const stream: unknown = Reflect.get(Object(connection), "stream");
    if (stream instanceof Duplex) stream.destroy();
  }

  #endTransaction(): void {
    this.#isInTransaction = false;
    this.#longTimeout = undefined;
  }
}
