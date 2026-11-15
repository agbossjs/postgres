import { describe, expect, it } from "vitest";
import { DEFAULT_CONNECT_TIMEOUT, PostgresSettingsError } from "../../src/index.js";
import { connectTimeoutOf } from "../../src/connection/connect-timeout.js";

const URL = "postgres://app:secret@db:5432/app";

describe("agbossjs/agboss#989: the connect bound a URL sets", () => {
  it("connect_timeout (libpq's, whole seconds) is the bound, in ms", () => {
    expect(connectTimeoutOf(`${URL}?connect_timeout=3`)).toBe(3000);
    expect(connectTimeoutOf(`${URL}?sslmode=require&connect_timeout=30`)).toBe(30_000);
  });

  it("none is DEFAULT_CONNECT_TIMEOUT; libpq reads 1 as 2 s, so does the bound (agbossjs/agboss#928)", () => {
    expect(connectTimeoutOf(URL)).toBe(DEFAULT_CONNECT_TIMEOUT);
    expect(connectTimeoutOf(`${URL}?connect_timeout=1`)).toBe(2000);
    expect(connectTimeoutOf(`${URL}?connect_timeout=5`)).toBe(5000);
  });

  it.each(["0", "-1", "1.5", "ten", ""])(
    "connect_timeout=%s fails with PostgresSettingsError, without printing the URL",
    (value) => {
      const failure = (): unknown => connectTimeoutOf(`${URL}?connect_timeout=${value}`);

      expect(failure).toThrow(PostgresSettingsError);
      expect(failure).toThrow(
        "the URL's connect_timeout must be a whole number of seconds, at least 1",
      );
      expect(failure).not.toThrow(/secret@db/u);
    },
  );
});
