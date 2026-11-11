import { describe, expect, it } from "vitest";
import { DEFAULT_POOL_SIZE, PostgresSettingsError, SchemaSetup } from "../../src/index.js";
import { searchPathOptionOf, settingsOfEnvironment } from "../../src/connection/settings.js";
import { revealing } from "../support/application-context.js";

const URL = "postgres://app:secret@db:5432/app";

describe("the environment fields of the PostgreSQL stores", () => {
  it("postgresUrl is a Secret: its revealed value is the URL; the others are optional", () => {
    expect(settingsOfEnvironment({ postgresUrl: revealing(URL) })).toEqual({
      url: URL,
      poolSize: undefined,
      schema: undefined,
      schemaSetup: undefined,
    });
    expect(DEFAULT_POOL_SIZE).toBe(10);
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
      schema: "app_a",
      schemaSetup: SchemaSetup.MigrateOnStart,
    });
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
    [{ postgresSchemaSetup: true }, /postgresSchemaSetup must be one of: check, migrate-on-start/],
    [
      { postgresSchemaSetup: "migrate" },
      /postgresSchemaSetup must be one of: check, migrate-on-start/,
    ],
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
