import {
  ApplicationContext,
  EnvironmentField,
  Injectable,
  type OnDestroy,
  type OnInit,
} from "@agboss/core";
import pg from "pg";
import { z } from "zod";
import { migrationsIn } from "../migrations/files.js";
import { once } from "./once.js";
import { PostgresListener, type PostgresListenerOptions } from "./listener.js";
import { checkSchema } from "../migrations/schema-check.js";
import {
  checkedSchemaOf,
  DEFAULT_POOL_SIZE,
  searchPathOptionOf,
  settingsOfEnvironment,
  type PostgresConnectionSettings,
} from "./settings.js";
import { SchemaSetup } from "@agboss/core/stores";

const SchemaRow = z.object({ schema: z.string().nullable() });

/** Each connection's URL, for `listenerOf` — the package's own plumbing, not the class's surface. */
const URLS = new WeakMap<object, string>();

/**
 * A `LISTEN` on `channel` over a connection of its own, outside `connection`'s pool
 * (agbossjs/agboss#777): what a store's watch is made of — the package's plumbing, not exported
 * (agbossjs/agboss#891). Rejects when its first connection fails.
 */
export function listenerOf(
  connection: PostgresConnection,
  options: Omit<PostgresListenerOptions, "url">,
): Promise<PostgresListener> {
  const url = URLS.get(connection);
  if (url === undefined) throw new Error("a PostgresConnection made outside its constructor");
  return PostgresListener.open({ ...options, url });
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
    postgresSchema: EnvironmentField.text({ optional: true }),
    postgresSchemaSetup: EnvironmentField.text({ optional: true }),
  },
})
export class PostgresConnection implements OnInit, OnDestroy {
  /** The instance's pool: every store's statements, every transaction's connection. */
  readonly pool: pg.Pool;
  readonly #settings: PostgresConnectionSettings;
  readonly #schema: () => Promise<string>;

  constructor(source: ApplicationContext | PostgresConnectionSettings) {
    this.#settings =
      source instanceof ApplicationContext ? settingsOfEnvironment(source.environment) : source;
    URLS.set(this, this.#settings.url);
    const schema = checkedSchemaOf(this.#settings.schema);
    this.pool = new pg.Pool({
      connectionString: this.#settings.url,
      max: this.#settings.poolSize ?? DEFAULT_POOL_SIZE,
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

  /** Ends the pool when the instance stops (its stores are destroyed first: they depend on it). */
  async onDestroy(): Promise<void> {
    if (!this.pool.ended) await this.pool.end();
  }

  async #currentSchema(): Promise<string> {
    const { rows } = await this.pool.query("SELECT current_schema() AS schema");
    const { schema } = SchemaRow.parse(rows[0]);
    if (schema === null) throw new Error("the connection's search_path names no existing schema");
    return schema;
  }
}
