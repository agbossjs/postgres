import {
  ApplicationContext,
  EnvironmentField,
  Injectable,
  type OnDestroy,
  type OnInit,
} from "@agboss/core";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import pg from "pg";
import { z } from "zod";
import { migrationsIn } from "../migrations/files.js";
import { PostgresConnectionClosedError } from "../errors.js";
import { once } from "./once.js";
import { connectTimeoutOf } from "./connect-timeout.js";
import { PostgresListener, type PostgresListenerOptions } from "./listener.js";
import { checkSchema } from "../migrations/schema-check.js";
import {
  checkedSchemaOf,
  checkedWatchLivenessOf,
  DEFAULT_POOL_SIZE,
  DEFAULT_WATCH_LIVENESS_SECONDS,
  searchPathOptionOf,
  settingsOfEnvironment,
  type PostgresConnectionSettings,
} from "./settings.js";
import { SchemaSetup } from "@agboss/core/stores";

const SchemaRow = z.object({ schema: z.string().nullable() });

/** The listeners opened over each connection: a stop that gave their owner up destroys them (#954). */
const LISTENERS = new WeakMap<object, Set<PostgresListener>>();

/** The connections whose `onDestroy` has started: no listener opens over them any more (#954). */
const CLOSED = new WeakSet<object>();

/** Each connection's settings, for `listenerOf` — the package's own plumbing, not the class's surface. */
const SETTINGS = new WeakMap<object, PostgresConnectionSettings>();

/**
 * A `LISTEN` on `channel` over a connection of its own, outside `connection`'s pool
 * (agbossjs/agboss#777): what a store's watch is made of — the package's plumbing, not exported
 * (agbossjs/agboss#891). Rejects when its first connection fails.
 */
export function listenerOf(
  connection: PostgresConnection,
  options: Omit<PostgresListenerOptions, "url" | "livenessSeconds">,
): Promise<PostgresListener> {
  const settings = SETTINGS.get(connection);
  if (settings === undefined) throw new Error("a PostgresConnection made outside its constructor");
  const open = LISTENERS.get(connection);
  if (open === undefined || CLOSED.has(connection))
    return Promise.reject(new PostgresConnectionClosedError());
  const livenessSeconds = settings.watchLivenessSeconds ?? DEFAULT_WATCH_LIVENESS_SECONDS;
  return PostgresListener.open({ ...options, url: settings.url, livenessSeconds }).then(
    (listener) => {
      // the stop began while it opened: the listener is dropped at once, its owner told
      if (CLOSED.has(connection)) {
        listener.destroy();
        throw new PostgresConnectionClosedError();
      }
      for (const other of open) if (other.closed) open.delete(other);
      open.add(listener);
      return listener;
    },
  );
}

/**
 * The PostgreSQL database of one application instance: one `pg.Pool` (`postgresPoolSize`
 * connections, default 10) on the environment's `postgresUrl`, shared by every PostgreSQL store the
 * application lists — two instances open two pools to one database. Created by the container
 * (`deps: [ApplicationContext]`), or by a script or a test from its settings
 * (`new PostgresConnection({ url })`). Every connection of the pool works in the settings' `schema`
 * (`postgresSchema`; its `search_path`, agbossjs/agboss#891), else in the URL's `search_path`. At
 * `onInit` it checks the schema (`SchemaSetup.MigrateOnStart` migrates it first) and, when the check
 * fails, ends the pool; at `onDestroy`, after its stores, it ends the pool. The DI token a subclass
 * of a PostgreSQL store names in its `deps`.
 */
@Injectable({
  deps: [ApplicationContext],
  // checked at the application's assembly (agbossjs/agboss#511): a contract without postgresUrl
  // fails with [environment.missing-field] before anything starts
  environmentFields: {
    postgresUrl: EnvironmentField.secret(),
    postgresPoolSize: EnvironmentField.integer({ optional: true }),
    postgresWatchLivenessSeconds: EnvironmentField.integer({ optional: true }),
    postgresSchema: EnvironmentField.text({ optional: true }),
    postgresSchemaSetup: EnvironmentField.text({ optional: true }),
  },
})
export class PostgresConnection implements OnInit, OnDestroy {
  /** The instance's pool: every store's statements, every transaction's connection. */
  readonly pool: pg.Pool;
  readonly #settings: PostgresConnectionSettings;
  readonly #schema: () => Promise<string>;
  /** The pool's clients, from their making to their end (even one still connecting): what `onDestroy` drops by force. */
  readonly #clients = new Set<() => void>();

  constructor(source: ApplicationContext | PostgresConnectionSettings) {
    // a copy: the caller changing its object after this line must not bypass the checks below, nor
    // change what the pool, the start and the watch read later (agbossjs/agboss#1129)
    this.#settings = Object.freeze({
      ...(source instanceof ApplicationContext
        ? settingsOfEnvironment(source.environment)
        : source),
    });
    checkedWatchLivenessOf(this.#settings.watchLivenessSeconds);
    SETTINGS.set(this, this.#settings);
    LISTENERS.set(this, new Set());
    const schema = checkedSchemaOf(this.#settings.schema);
    const clients = this.#clients;
    // a client of the pool whose socket is ours to drop: `pg`'s graceful `end()` waits for a server
    // that does not answer, and `pool.end()` for every client's `end()`
    class TrackedClient extends pg.Client {
      constructor(config?: string | pg.ClientConfig) {
        const given = typeof config === "string" ? { connectionString: config } : (config ?? {});
        let socket: Duplex | undefined;
        super({
          ...given,
          stream: () => {
            socket = typeof given.stream === "function" ? given.stream() : new Socket();
            return socket;
          },
        });
        const drop = (): void => {
          socket?.destroy();
        };
        clients.add(drop);
        this.once("end", () => clients.delete(drop));
      }
    }
    this.pool = new pg.Pool({
      Client: TrackedClient,
      connectionString: this.#settings.url,
      max: this.#settings.poolSize ?? DEFAULT_POOL_SIZE,
      // agbossjs/agboss#989: a connection that never answers rejects the call, never hangs it
      connectionTimeoutMillis: connectTimeoutOf(this.#settings.url),
      ...(schema === undefined ? {} : { options: searchPathOptionOf(schema) }),
    });
    // an idle connection that fails leaves the pool by itself; the next statement opens a new one,
    // and an operation in flight rejects with its own error — nothing to do here but not crash
    this.pool.on("error", () => undefined);
    this.#schema = once(() => this.#currentSchema());
  }

  /**
   * The schema the stores' tables are in — the settings' `schema`, else the first existing one of
   * the URL's `search_path` (`DEFAULT_SCHEMA` by default), read on the first call.
   */
  schema(): Promise<string> {
    return this.#schema();
  }

  /** One `SELECT 1` (#300): every PostgreSQL store's `ping()`. Rejects when the database does not answer. */
  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  /**
   * The schema check at start: the database at this package's migrations; missing or older ones
   * migrated now under `SchemaSetup.MigrateOnStart`, else `PostgresSchemaMissingError`; a newer
   * schema → `PostgresSchemaTooNewError`. A check that fails ends the pool first (agbossjs/agboss#891):
   * a start that failed leaves no connection open.
   */
  async onInit(): Promise<void> {
    try {
      await checkSchema({
        url: this.#settings.url,
        schema: this.#settings.schema,
        pool: this.pool,
        schemaSetup: this.#settings.schemaSetup ?? SchemaSetup.Check,
        files: migrationsIn(),
      });
    } catch (error) {
      await this.onDestroy().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Ends the pool when the instance stops (its stores are destroyed first: they depend on it).
   * `pool.end()` returns only when every client is back, and a client in the middle of a statement
   * the server never answers does not come back: the idle ones leave at once, the ones in use are
   * dropped (their statement rejects) and not waited for (agbossjs/agboss#954). The listeners
   * still open — their owner was given up on by the stop — are dropped too: no socket is left.
   */
  async onDestroy(): Promise<void> {
    CLOSED.add(this);
    const listeners = LISTENERS.get(this);
    for (const listener of [...(listeners ?? [])]) listener.destroy();
    listeners?.clear();
    if (this.pool.ended) return;
    const ending = this.pool.end();
    const open = [...this.#clients];
    for (const drop of open) drop();
    // with clients dropped the statements in flight reject and their holders release: not waited for
    if (open.length === 0) await ending;
    else ending.catch(() => undefined);
  }

  async #currentSchema(): Promise<string> {
    const { rows } = await this.pool.query("SELECT current_schema() AS schema");
    const { schema } = SchemaRow.parse(rows[0]);
    if (schema === null) throw new Error("the connection's search_path names no existing schema");
    return schema;
  }
}
