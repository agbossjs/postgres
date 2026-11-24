import { secret } from "@agboss/core";
import { SchemaSetup, StorageRole, type ResolvedSettings } from "@agboss/core/stores";
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresDriver, PostgresSettingsError } from "../../src/index.js";
import { settingsOfResolved } from "../../src/connection/driver-settings.js";
import { revealing } from "../support/application-context.js";

/**
 * `PostgresDriver` (agbossjs/agboss#1321) and the settings it resolves to: the URL a `secret(…)`
 * revealed once, the durations in milliseconds, nothing printed that is a secret.
 */
const URL = "postgres://user:pw@db.internal:5432/app";

describe("PostgresDriver", () => {
  const driver = PostgresDriver({
    url: secret("POSTGRES_URL"),
    schema: "billing",
    poolSize: 4,
    schemaSetup: SchemaSetup.Check,
    timeouts: { commandTimeout: seconds(5) },
  });

  it("is a database driver of the postgres backend that describes where it points, never a secret", () => {
    expect(Object.isFrozen(driver)).toBe(true);
    expect(driver).toMatchObject({
      role: StorageRole.Database,
      backend: "postgres",
      describes: "postgres (schema billing)",
    });
    expect(JSON.stringify(driver.describes)).not.toContain("pw");
  });

  it("lists the connection and every store, with the lease store and the coordination stores named", () => {
    expect(driver.providers).toHaveLength(16);
    expect(driver.leaseStore?.name).toBe("PostgresExecutionLeaseRepository");
    expect(driver.coordinationStores?.map((store) => store.name)).toEqual([
      "PostgresExecutionLeaseRepository",
      "PostgresChildExecutionQueueRepository",
      "PostgresRateLimitRepository",
    ]);
    expect(driver.migrate).toBeTypeOf("function");
  });

  it("keeps the options as settings: the URL as the reference, the durations in ms", () => {
    expect(driver.settings).toMatchObject({
      kind: "postgres",
      schema: "billing",
      poolSize: 4,
      commandTimeout: 5000,
    });
  });
});

describe("settingsOfResolved", () => {
  const resolved = (extra: Record<string, unknown> = {}): ResolvedSettings => ({
    kind: "postgres",
    url: revealing(URL),
    ...extra,
  });

  it("reveals the URL and converts the watch's liveness to seconds", () => {
    expect(
      settingsOfResolved(
        resolved({
          schema: "billing",
          poolSize: 3,
          watchLiveness: 20_000,
          commandTimeout: 5000,
          idleInTransactionTimeout: 2000,
          schemaSetup: SchemaSetup.MigrateOnStart,
        }),
      ),
    ).toEqual({
      url: URL,
      poolSize: 3,
      schema: "billing",
      schemaSetup: SchemaSetup.MigrateOnStart,
      watchLivenessSeconds: 20,
      commandTimeout: 5000,
      idleInTransactionTimeout: 2000,
    });
  });

  it.each([
    ["another driver's settings", { kind: "sqlite", path: "x" }],
    ["a URL that is no secret", { kind: "postgres", url: URL }],
    ["an empty URL", { kind: "postgres", url: revealing("") }],
    [
      "a schema that is no identifier",
      { kind: "postgres", url: revealing(URL), schema: "Bad Name" },
    ],
    [
      "a command timeout out of range",
      { kind: "postgres", url: revealing(URL), commandTimeout: 5 },
    ],
    ["a pool of none", { kind: "postgres", url: revealing(URL), poolSize: 0 }],
  ])("%s is a PostgresSettingsError", (_name, settings) => {
    expect(() => settingsOfResolved(settings as ResolvedSettings)).toThrow(PostgresSettingsError);
  });

  it("an error never names the URL", () => {
    try {
      settingsOfResolved({ kind: "postgres", url: revealing(URL), poolSize: 0 });
    } catch (error) {
      expect(String(error)).not.toContain("pw");
    }
    expect.hasAssertions();
  });
});
