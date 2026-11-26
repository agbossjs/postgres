/**
 * agbossjs/agboss#1029: `watchLivenessSeconds` of a settings object (a script's, a `useValue`
 * provider's) is checked as the driver's `timeouts.watchLiveness` is — a whole number of seconds, at least 2 — and a
 * value the watch cannot run on is a `PostgresSettingsError` naming the field, not a watch that fails later.
 */
import { describe, expect, it } from "vitest";
import { PostgresConnection, PostgresSettingsError } from "../../src/index.js";
import { revealing } from "../support/application-context.js";

const URL = "postgres://app:secret@db:5432/app";
const REFUSED = [0, 1, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY];

describe("agbossjs/agboss#1029: the watch's liveness bound in a settings object", () => {
  it.each(REFUSED)(
    "AC1: watchLivenessSeconds { %s } is a PostgresSettingsError naming the field",
    (value) => {
      expect(() => new PostgresConnection({ url: URL, watchLivenessSeconds: value })).toThrow(
        PostgresSettingsError,
      );
      expect(() => new PostgresConnection({ url: URL, watchLivenessSeconds: value })).toThrow(
        /watchLivenessSeconds must be a whole number of at least 2/,
      );
    },
  );

  it.each([2, 10])("AC1: watchLivenessSeconds { %s } is accepted", async (value) => {
    const connection = new PostgresConnection({ url: URL, watchLivenessSeconds: value });
    expect(connection).toBeInstanceOf(PostgresConnection);
    await connection.onDestroy();
  });

  it("AC1: no bound set is accepted (the default)", async () => {
    const connection = new PostgresConnection({ url: URL });
    expect(connection).toBeInstanceOf(PostgresConnection);
    await connection.onDestroy();
  });

  it("AC2: the driver's resolved settings are checked alike: a watch liveness under 2 s is refused, naming the field", () => {
    const resolved = (watchLiveness: number) =>
      new PostgresConnection({ kind: "postgres", url: revealing(URL), watchLiveness });
    expect(() => resolved(1000)).toThrow(
      /watchLivenessSeconds must be a whole number of at least 2/,
    );
    expect(() => resolved(500)).toThrow(PostgresSettingsError);
    const connection = resolved(2000);
    expect(connection).toBeInstanceOf(PostgresConnection);
    return connection.onDestroy();
  });
});
