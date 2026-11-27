import { Injectable, type OnDestroy, type OnInit } from "@agboss/core";
import pg from "pg";
import { z } from "zod";
import { migrationsIn } from "../migrations/files.js";
import { PostgresConnectionClosedError, PostgresSettingsError } from "../errors.js";
import { trackedClientOf } from "./tracked-client.js";
import { requiredTransaction } from "./ambient.js";
import { once } from "./once.js";
import { PostgresListener, type PostgresListenerOptions } from "./listener.js";
import { checkSchema } from "../migrations/schema-check.js";
import { poolOptionsOf } from "./pool-options.js";
import { timedPool } from "./timed-pool.js";
import { TimedClient } from "./timed-client.js";
import {
  checkedWatchLivenessOf,
  DEFAULT_WATCH_LIVENESS_SECONDS,
  type PostgresConnectionSettings,
} from "./settings.js";
import { DATABASE_SETTINGS, SchemaSetup, type ResolvedSettings } from "@agboss/core/stores";
import { settingsOfResolved } from "./driver-settings.js";

/**
 * The settings of a connection: the resolved settings of the application's `@DatabaseStorage` of
 * `PostgresDriver` (agbossjs/agboss#1321), else the settings object a script or a test gave. An
 * application with no PostgreSQL storage and no object is `PostgresSettingsError`: the
 * environment is no source of the connection any more (agbossjs/agboss#1324).
 */
function settingsOf(
  source: PostgresConnectionSettings | ResolvedSettings | undefined,
): PostgresConnectionSettings {
  if (source === undefined)
    throw new PostgresSettingsError({
      message:
        "the PostgreSQL stores need the application's @DatabaseStorage({ driver: PostgresDriver({ url: secret(…) }) }) — the database they open",
    });
  if ("kind" in source) return settingsOfResolved(source);
  return source;
}

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
 * The PostgreSQL database of one application instance: one `pg.Pool` (`poolSize` connections,
 * default 10) on the `url` of the application's `@DatabaseStorage({ driver: PostgresDriver({ url }) })`,
 * shared by every PostgreSQL store the application lists — two instances open two pools to one
 * database. Created by the container (`deps: [DATABASE_SETTINGS]`), or by a script or a test from
 * its settings (`new PostgresConnection({ url })`). Every connection of the pool works in the
 * settings' `schema` (its `search_path`, agbossjs/agboss#891), else in the URL's `search_path`. At
 * `onInit` it checks the schema (`SchemaSetup.MigrateOnStart` migrates it first) and, when the check
 * fails, ends the pool; at `onDestroy`, after its stores, it ends the pool. The DI token a subclass
 * of a PostgreSQL store names in its `deps`.
 */
@Injectable({ deps: [DATABASE_SETTINGS] })
export class PostgresConnection implements OnInit, OnDestroy {
  /** The instance's pool: every store's statements, every transaction's connection. */
  readonly pool: pg.Pool;
  readonly #settings: PostgresConnectionSettings;
  readonly #schema: () => Promise<string>;
  /** The pool's clients, from their making to their end (even one still connecting): what `onDestroy` drops by force. */
  readonly #clients = new Set<() => void>();

  constructor(source?: PostgresConnectionSettings | ResolvedSettings) {
    // a copy: the caller changing its object after this line must not bypass the checks below, nor
    // change what the pool, the start and the watch read later (agbossjs/agboss#1129)
    this.#settings = Object.freeze({
      ...settingsOf(source),
    });
    checkedWatchLivenessOf(this.#settings.watchLivenessSeconds);
    SETTINGS.set(this, this.#settings);
    LISTENERS.set(this, new Set());
    // every client is tracked (agbossjs/agboss#954: its socket is dropped at the stop) and timed
    // (agbossjs/agboss#928: its failures are read as store errors)
    const options = {
      ...poolOptionsOf(this.#settings),
      Client: trackedClientOf(this.#clients, TimedClient),
    };
    this.pool = timedPool(new pg.Pool(options));
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

  /**
   * The transaction of the `runOnce` the caller is inside of (agbossjs/agboss#1317c): the effect's
   * business rows are written through it and roll back with it on any uncaught error.
   * `IdempotencyError.OutsideTransaction` outside one.
   */
  requireTransaction(): pg.PoolClient {
    return requiredTransaction(this);
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
        allowLiveLeases: this.#settings.allowLiveLeases,
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
