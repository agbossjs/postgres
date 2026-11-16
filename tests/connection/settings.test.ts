import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMAND_TIMEOUT,
  DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT,
  DEFAULT_POOL_SIZE,
  PostgresConnection,
  DEFAULT_WATCH_LIVENESS_SECONDS,
  PostgresSettingsError,
  SchemaSetup,
} from "../../src/index.js";
import { searchPathOptionOf, settingsOfEnvironment } from "../../src/connection/settings.js";
import { revealing } from "../support/application-context.js";

const URL = "postgres://app:secret@db:5432/app";

describe("agbossjs/agboss#928: the command timeout fields", () => {
  it("postgresCommandTimeoutMs and postgresIdleInTransactionTimeoutMs are read when set", () => {
    const settings = settingsOfEnvironment({
      postgresUrl: revealing(URL),
      postgresCommandTimeoutMs: 2500,
      postgresIdleInTransactionTimeoutMs: 4000,
    });

    expect(settings).toMatchObject({ commandTimeout: 2500, idleInTransactionTimeout: 4000 });
    expect(DEFAULT_COMMAND_TIMEOUT).toBe(10_000);
    expect(DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT).toBe(10_000);
  });

  it.each([0, -5, 99, 30_001, 1.5])(
    "postgresCommandTimeoutMs %s is refused with PostgresSettingsError naming the field, never the URL",
    (value) => {
      const failure = (): unknown =>
        settingsOfEnvironment({ postgresUrl: revealing(URL), postgresCommandTimeoutMs: value });

      expect(failure).toThrow(PostgresSettingsError);
      expect(failure).toThrow(/postgresCommandTimeoutMs must be a whole number of milliseconds/u);
      expect(failure).not.toThrow(/secret@db/u);
    },
  );

  it("postgresIdleInTransactionTimeoutMs 0 is refused the same way", () => {
    expect(() =>
      settingsOfEnvironment({
        postgresUrl: revealing(URL),
        postgresIdleInTransactionTimeoutMs: 0,
      }),
    ).toThrow(/postgresIdleInTransactionTimeoutMs must be a whole number/u);
  });

  it("a settings object is checked as the environment is: 0 and 30 001 fail at construction", () => {
    for (const commandTimeout of [0, 30_001])
      expect(() => new PostgresConnection({ url: URL, commandTimeout })).toThrow(
        /commandTimeout must be a whole number of milliseconds/u,
      );
    expect(() => new PostgresConnection({ url: URL, idleInTransactionTimeout: 0 })).toThrow(
      /idleInTransactionTimeout/u,
    );
  });

  it("the pool carries them: statement_timeout, query_timeout a second later, idle_in_transaction_session_timeout", async () => {
    const connection = new PostgresConnection({
      url: URL,
      commandTimeout: 2500,
      idleInTransactionTimeout: 4000,
    });
    const defaults = new PostgresConnection({ url: URL });

    expect(connection.pool.options).toMatchObject({
      statement_timeout: 2500,
      query_timeout: 3500,
      idle_in_transaction_session_timeout: 4000,
      keepAlive: true,
    });
    expect(defaults.pool.options).toMatchObject({
      statement_timeout: 10_000,
      query_timeout: 11_000,
      idle_in_transaction_session_timeout: 10_000,
    });
    await connection.onDestroy();
    await defaults.onDestroy();
  });
});

describe("the environment fields of the PostgreSQL stores", () => {
  it("postgresUrl is a Secret: its revealed value is the URL; the others are optional", () => {
    expect(settingsOfEnvironment({ postgresUrl: revealing(URL) })).toEqual({
      url: URL,
      poolSize: undefined,
      watchLivenessSeconds: undefined,
      commandTimeout: undefined,
      idleInTransactionTimeout: undefined,
      schema: undefined,
      schemaSetup: undefined,
    });
    expect(DEFAULT_POOL_SIZE).toBe(10);
    expect(DEFAULT_WATCH_LIVENESS_SECONDS).toBe(10);
  });

  it("agbossjs/agboss#891: postgresPoolSize, postgresSchema and postgresSchemaSetup are read when set", () => {
    const settings = settingsOfEnvironment({
      postgresUrl: revealing(URL),
      postgresPoolSize: 3,
      postgresSchema: "app_a",
      postgresSchemaSetup: "migrate-on-start",
    });

    expect(settings).toEqual({
      url: URL,
      poolSize: 3,
      watchLivenessSeconds: undefined,
      schema: "app_a",
      schemaSetup: SchemaSetup.MigrateOnStart,
    });
  });

  it("agbossjs/agboss#1104: postgresAllowLiveLeases is read when set, false by default", () => {
    expect(
      settingsOfEnvironment({ postgresUrl: revealing(URL), postgresAllowLiveLeases: true }),
    ).toMatchObject({ allowLiveLeases: true });
    expect(settingsOfEnvironment({ postgresUrl: revealing(URL) }).allowLiveLeases).toBeUndefined();
  });

  it("agbossjs/agboss#789: postgresWatchLivenessSeconds is read when set", () => {
    expect(
      settingsOfEnvironment({ postgresUrl: revealing(URL), postgresWatchLivenessSeconds: 6 }),
    ).toMatchObject({ watchLivenessSeconds: 6 });
  });

  it("agbossjs/agboss#891: the search_path option names the schema quoted", () => {
    expect(searchPathOptionOf("app_a")).toBe('-c search_path="app_a"');
  });

  it("a missing postgresUrl fails, naming the field and how to declare it", () => {
    expect(() => settingsOfEnvironment({})).toThrow(PostgresSettingsError);
    expect(() => settingsOfEnvironment({})).toThrow(
      /postgresUrl is missing: declare postgresUrl!: Secret/,
    );
  });

  it("a postgresUrl that is a plain string, not a Secret, fails without printing it", () => {
    const failure = (): unknown => settingsOfEnvironment({ postgresUrl: URL });

    expect(failure).toThrow(/postgresUrl must be a Secret/);
    expect(failure).not.toThrow(/secret@db/);
  });

  it("an empty postgresUrl fails", () => {
    expect(() => settingsOfEnvironment({ postgresUrl: revealing("") })).toThrow(
      "postgresUrl is empty",
    );
  });

  it.each([
    [{ postgresPoolSize: 0 }, /postgresPoolSize must be at least 1/],
    [{ postgresPoolSize: 2.5 }, /postgresPoolSize must be a whole number/],
    [{ postgresPoolSize: "10" }, /postgresPoolSize must be a number/],
    [{ postgresWatchLivenessSeconds: 1 }, /postgresWatchLivenessSeconds must be at least 2/],
    [{ postgresWatchLivenessSeconds: 2.5 }, /postgresWatchLivenessSeconds must be a whole number/],
    [{ postgresWatchLivenessSeconds: "5" }, /postgresWatchLivenessSeconds must be a number/],
    [{ postgresSchemaSetup: true }, /postgresSchemaSetup must be one of: check, migrate-on-start/],
    [
      { postgresSchemaSetup: "migrate" },
      /postgresSchemaSetup must be one of: check, migrate-on-start/,
    ],
    [{ postgresAllowLiveLeases: "true" }, /postgresAllowLiveLeases must be true or false/],
    [{ postgresSchema: 1 }, /postgresSchema must be a text/],
    [{ postgresSchema: "" }, /the schema name is empty/],
    [{ postgresSchema: "App A" }, /plain lowercase identifier/],
  ])("a mistyped field fails, naming it: %o", (fields, message) => {
    expect(() => settingsOfEnvironment({ postgresUrl: revealing(URL), ...fields })).toThrow(
      message,
    );
  });

  it("the error has its stable code", () => {
    expect(PostgresSettingsError.code).toBe("postgres.settings-invalid");
  });
});
