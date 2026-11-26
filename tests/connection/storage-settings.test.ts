/**
 * The connection's settings are the application's `@DatabaseStorage` (agbossjs/agboss#1321,
 * #1324): an application that lists a PostgreSQL store with no storage names no database, and its
 * start fails with `PostgresSettingsError` naming the storage to declare — before any connection is
 * built, nothing connects. The environment is no source of the connection any more.
 */
import { createApp } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseRepository, PostgresSettingsError } from "../../src/index.js";
import { storeLayoutOf } from "../fixtures/store-layout.application.js";

/** `error`, and every `cause` under it. */
const chainOf = (error: unknown): unknown[] =>
  error instanceof Error ? [error, ...chainOf(error.cause)] : [error];

describe("PostgresConnection with no @DatabaseStorage", () => {
  it("fails where it is built with PostgresSettingsError naming the storage to declare, before anything connects", async () => {
    const error: unknown = await createApp(storeLayoutOf([PostgresExecutionLeaseRepository])).then(
      async (app) => {
        try {
          app.resolve(PostgresExecutionLeaseRepository);
          return undefined;
        } catch (thrown) {
          return thrown;
        } finally {
          await app.close();
        }
      },
      (thrown: unknown) => thrown,
    );

    const settings = chainOf(error).find((link) => link instanceof PostgresSettingsError);
    expect(settings).toBeInstanceOf(PostgresSettingsError);
    expect(String(settings)).toContain("PostgresDriver");
  });
});
