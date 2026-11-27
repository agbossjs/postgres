import type { ResolvedSettings } from "@agboss/core/stores";
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
import { poolOptionsOf } from "../../src/connection/pool-options.js";
import { searchPathOptionOf, sessionOptionsOf } from "../../src/connection/settings.js";
import { settingsOfResolved } from "../../src/connection/driver-settings.js";
import { revealing } from "../support/application-context.js";

const URL = "postgres://app:secret@db:5432/app";

const resolved = (fields: Record<string, unknown> = {}): ResolvedSettings => ({
  kind: "postgres",
  url: revealing(URL),
  ...fields,
});

describe("agbossjs/agboss#928: the command timeout options", () => {
  it("commandTimeout and idleInTransactionTimeout are read when set", () => {
    const settings = settingsOfResolved(
      resolved({ commandTimeout: 2500, idleInTransactionTimeout: 4000 }),
    );

    expect(settings).toMatchObject({ commandTimeout: 2500, idleInTransactionTimeout: 4000 });
    expect(DEFAULT_COMMAND_TIMEOUT).toBe(10_000);
    expect(DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT).toBe(10_000);
  });

  it.each([0, -5, 99, 30_001, 1.5])(
    "commandTimeout %s is refused with PostgresSettingsError naming the field, never the URL",
    (value) => {
      const failure = (): unknown => settingsOfResolved(resolved({ commandTimeout: value }));

      expect(failure).toThrow(PostgresSettingsError);
      expect(failure).toThrow(/commandTimeout must be a whole number of milliseconds/u);
      expect(failure).not.toThrow(/secret@db/u);
    },
  );

  it("idleInTransactionTimeout 0 is refused the same way", () => {
    expect(() => settingsOfResolved(resolved({ idleInTransactionTimeout: 0 }))).toThrow(
      /idleInTransactionTimeout must be a whole number/u,
    );
  });

  it("a settings object is checked as the driver's are: 0 and 30 001 fail at construction", () => {
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

describe("the settings of the PostgreSQL stores", () => {
  it("the driver's url is a secret: its revealed value is the URL; the others are optional", () => {
    expect(settingsOfResolved(resolved())).toEqual({
      url: URL,
      poolSize: undefined,
      schema: undefined,
      schemaSetup: undefined,
      watchLivenessSeconds: undefined,
      commandTimeout: undefined,
      idleInTransactionTimeout: undefined,
    });
    expect(DEFAULT_POOL_SIZE).toBe(10);
    expect(DEFAULT_WATCH_LIVENESS_SECONDS).toBe(10);
  });

  it("agbossjs/agboss#891: poolSize, schema and schemaSetup are read when set", () => {
    const settings = settingsOfResolved(
      resolved({ poolSize: 3, schema: "app_a", schemaSetup: SchemaSetup.MigrateOnStart }),
    );

    expect(settings).toEqual({
      url: URL,
      poolSize: 3,
      watchLivenessSeconds: undefined,
      commandTimeout: undefined,
      idleInTransactionTimeout: undefined,
      schema: "app_a",
      schemaSetup: SchemaSetup.MigrateOnStart,
    });
  });

  it("agbossjs/agboss#789: the watch's liveness is read in seconds", () => {
    expect(settingsOfResolved(resolved({ watchLiveness: 6000 }))).toMatchObject({
      watchLivenessSeconds: 6,
    });
  });

  it("agbossjs/agboss#891: the search_path option names the schema quoted", () => {
    expect(searchPathOptionOf("app_a")).toBe('-c search_path="app_a"');
  });

  it("agbossjs/agboss#1307: every session is in UTC, with or without a schema", () => {
    expect(sessionOptionsOf(undefined)).toBe("-c timezone=UTC");
    expect(sessionOptionsOf("app_a")).toBe('-c timezone=UTC -c search_path="app_a"');
    expect(poolOptionsOf({ url: "postgres://h/d" }).options).toBe("-c timezone=UTC");
    expect(poolOptionsOf({ url: "postgres://h/d", schema: "app_a" }).options).toBe(
      '-c timezone=UTC -c search_path="app_a"',
    );
  });

  it("no settings at all (an application with no PostgreSQL storage) fails, naming the storage to declare", () => {
    const build = (): unknown => new PostgresConnection(undefined);

    expect(build).toThrow(PostgresSettingsError);
    expect(build).toThrow(/@DatabaseStorage\(\{ driver: PostgresDriver/);
  });

  it("another driver's settings fail without printing a URL", () => {
    const build = (): unknown => new PostgresConnection({ kind: "sqlite", path: "x" });

    expect(build).toThrow(PostgresSettingsError);
  });

  it.each([
    [{ poolSize: 0 }, /the PostgreSQL driver's settings are wrong/],
    [{ schema: "" }, /the schema name is empty/],
    [{ schema: "App A" }, /plain lowercase identifier/],
  ])("a wrong option fails: %o", (fields, message) => {
    expect(() => settingsOfResolved(resolved(fields))).toThrow(message);
  });

  it("the error has its stable code", () => {
    expect(PostgresSettingsError.code).toBe("postgres.settings-invalid");
  });
});
