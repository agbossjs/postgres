import { describe, expect, it } from "vitest";
import { DEFAULT_CONNECT_TIMEOUT, PostgresSettingsError } from "../../src/index.js";
import { connectTimeoutOf } from "../../src/connection/connect-timeout.js";

const URL = "postgres://app:secret@db:5432/app";

describe("agbossjs/agboss#1213: connect_timeout as the URL spells it", () => {
  it("surrounding whitespace is allowed around the whole number", () => {
    expect(connectTimeoutOf(`${URL}?connect_timeout=%205%20`)).toBe(5000);
    expect(connectTimeoutOf(`${URL}?connect_timeout=%0A7`)).toBe(7000);
  });

  it("whitespace inside the number, or only whitespace, is refused", () => {
    for (const value of ["1%200", "%20", "5%20s"])
      expect(() => connectTimeoutOf(`${URL}?connect_timeout=${value}`)).toThrow(
        PostgresSettingsError,
      );
  });

  it("a URL that does not parse has no connect_timeout: the default", () => {
    expect(connectTimeoutOf("not a url?connect_timeout=3")).toBe(DEFAULT_CONNECT_TIMEOUT);
    expect(connectTimeoutOf("")).toBe(DEFAULT_CONNECT_TIMEOUT);
  });

  it("the largest bound is an hour, one second above fails naming it", () => {
    expect(connectTimeoutOf(`${URL}?connect_timeout=3600`)).toBe(3_600_000);
    expect(() => connectTimeoutOf(`${URL}?connect_timeout=3601`)).toThrow(
      "the URL's connect_timeout must be a whole number of seconds, at most 3600",
    );
  });
});
