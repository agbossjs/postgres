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
import { checkSchema } from "../migrations/schema-check.js";
import {
  DEFAULT_POOL_SIZE,
  settingsOfEnvironment,
  type PostgresConnectionSettings,
} from "./settings.js";

const SchemaRow = z.object({ schema: z.string().nullable() });

/**
 * The PostgreSQL database of one application instance: one `pg.Pool` (`postgresPoolSize`
 * connections, default 10) on the environment's `postgresUrl`, shared by every PostgreSQL store the
 * application lists — two instances open two pools to one database. Created by the container
 * (`deps: [ApplicationContext]`), or by a script or a test from its settings
 * (`new PostgresConnection({ url })`). At `onInit` it checks the schema (`postgresMigrateOnStart`
 * migrates it); at `onDestroy`, after its stores, it ends the pool. The DI token a subclass of a
 * PostgreSQL store names in its `deps`.
 */
@Injectable({
  deps: [ApplicationContext],
  // checked at the application's assembly (agbossjs/agboss#511): a contract without postgresUrl
  // fails with [environment.missing-field] before anything starts
  environmentFields: {
    postgresUrl: EnvironmentField.Secret,
    postgresPoolSize: EnvironmentField.OptionalInteger,
    postgresMigrateOnStart: EnvironmentField.OptionalFlag,
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
    this.pool = new pg.Pool({
      connectionString: this.#settings.url,
      max: this.#settings.poolSize ?? DEFAULT_POOL_SIZE,
    });
    // an idle connection that fails leaves the pool by itself; the next statement opens a new one,
    // and an operation in flight rejects with its own error — nothing to do here but not crash
    this.pool.on("error", () => undefined);
    this.#schema = once(() => this.#currentSchema());
  }

  /**
   * The schema the stores' tables are in — the first existing one of the connection's
   * `search_path` (`public` by default), read on the first call.
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
   * migrated now with `postgresMigrateOnStart`, else `PostgresSchemaMissingError`; a newer schema
   * → `PostgresSchemaTooNewError`.
   */
  async onInit(): Promise<void> {
    await checkSchema({
      url: this.#settings.url,
      pool: this.pool,
      migrateOnStart: this.#settings.migrateOnStart ?? false,
      files: migrationsIn(),
    });
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
