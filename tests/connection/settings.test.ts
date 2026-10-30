import { describe, expect, it } from "vitest";
import { PostgresSettingsError } from "../../src/index.js";
import { DEFAULT_POOL_SIZE, settingsOfEnvironment } from "../../src/connection/settings.js";
import { revealing } from "../support/application-context.js";

const URL = "postgres://app:secret@db:5432/app";

describe("the environment fields of the PostgreSQL stores", () => {
  it("postgresUrl is a Secret: its revealed value is the URL; the others are optional", () => {
    expect(settingsOfEnvironment({ postgresUrl: revealing(URL) })).toEqual({
      url: URL,
      poolSize: undefined,
      migrateOnStart: undefined,
    });
    expect(DEFAULT_POOL_SIZE).toBe(10);
  });

  it("postgresPoolSize and postgresMigrateOnStart are read when set", () => {
    const settings = settingsOfEnvironment({
      postgresUrl: revealing(URL),
      postgresPoolSize: 3,
      postgresMigrateOnStart: true,
    });

    expect(settings).toEqual({ url: URL, poolSize: 3, migrateOnStart: true });
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
    [{ postgresMigrateOnStart: "yes" }, /postgresMigrateOnStart must be a flag/],
  ])("a mistyped field fails, naming it: %o", (fields, message) => {
    expect(() => settingsOfEnvironment({ postgresUrl: revealing(URL), ...fields })).toThrow(
      message,
    );
  });

  it("the error has its stable code", () => {
    expect(PostgresSettingsError.code).toBe("postgres.settings-invalid");
  });
});
