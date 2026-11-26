/**
 * agbossjs/agboss#1129: a timer-backed duration has an upper limit. `watchLivenessSeconds` above
 * `MAX_WATCH_LIVENESS_SECONDS` (3600) and a URL's `connect_timeout` above
 * `MAX_CONNECT_TIMEOUT_SECONDS` are a `PostgresSettingsError` naming the field on every path — a
 * Node timer holds at most 2^31-1 ms, and 2147484 s made the watch fail at once and the instance
 * silently fall back to the sweep. The connection copies the settings object it is given.
 */
import type { ResolvedSettings } from "@agboss/core/stores";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresConnection, PostgresSettingsError } from "../../src/index.js";
import {
  connectTimeoutOf,
  MAX_CONNECT_TIMEOUT_SECONDS,
} from "../../src/connection/connect-timeout.js";
import { PostgresListener } from "../../src/connection/listener.js";
import { listenerOf } from "../../src/connection/postgres-connection.js";
import { MAX_WATCH_LIVENESS_SECONDS } from "../../src/connection/settings.js";
import { revealing } from "../support/application-context.js";

const URL = "postgres://app:secret@db:5432/app";
const TOO_LONG = [3601, 86_400, 2_147_483, 2_147_484, 2 ** 31, Number.MAX_SAFE_INTEGER];

/** The settings the driver resolved: the watch's liveness in ms, the URL a revealing secret. */
const resolved = (seconds: number, url = URL): ResolvedSettings => ({
  kind: "postgres",
  url: revealing(url),
  watchLiveness: seconds * 1000,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agbossjs/agboss#1129: the watch's liveness bound has an upper limit", () => {
  it("AC1: the limits are far under what a Node timer holds", () => {
    expect(MAX_WATCH_LIVENESS_SECONDS).toBe(3600);
    expect(MAX_CONNECT_TIMEOUT_SECONDS).toBe(3600);
    expect(MAX_WATCH_LIVENESS_SECONDS * 1000).toBeLessThan(2 ** 31 - 1);
  });

  it.each(TOO_LONG)(
    "AC1: watchLivenessSeconds { %s } in a settings object is a PostgresSettingsError naming the field",
    (value) => {
      const build = (): unknown =>
        new PostgresConnection({ url: URL, watchLivenessSeconds: value });
      expect(build).toThrow(PostgresSettingsError);
      expect(build).toThrow(
        /watchLivenessSeconds must be a whole number of at least 2 and at most 3600/,
      );
      expect(build).not.toThrow(/secret@db/u);
    },
  );

  it.each(TOO_LONG)(
    "AC2: a watchLiveness of { %s } s in the driver's resolved settings is a PostgresSettingsError naming the field",
    (value) => {
      const build = (): unknown => new PostgresConnection(resolved(value));
      expect(build).toThrow(PostgresSettingsError);
      expect(build).toThrow(
        /watchLivenessSeconds must be a whole number of at least 2 and at most 3600/,
      );
    },
  );

  it.each([2, 3600])(
    "AC3: the limit itself and the minimum, { %s }, are accepted on both paths (the settings object, the driver's resolved settings)",
    async (value) => {
      const open = vi.spyOn(PostgresListener, "open").mockRejectedValue(new Error("not opened"));
      for (const connection of [
        new PostgresConnection({ url: URL, watchLivenessSeconds: value }),
        new PostgresConnection(resolved(value)),
      ]) {
        await expect(listenerOf(connection, listenerOptions)).rejects.toThrow("not opened");
        expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ livenessSeconds: value }));
        await connection.onDestroy();
      }
    },
  );

  it("AC4: the connection copies the settings: changing the object afterwards changes nothing it reads", async () => {
    const open = vi.spyOn(PostgresListener, "open").mockRejectedValue(new Error("not opened"));
    const settings: { url: string; watchLivenessSeconds?: number; schema?: string } = {
      url: URL,
      watchLivenessSeconds: 10,
      schema: "app_a",
    };
    const connection = new PostgresConnection(settings);
    settings.watchLivenessSeconds = 2_147_484;
    settings.url = "postgres://elsewhere:5432/other";
    settings.schema = "Not A Schema";

    await expect(listenerOf(connection, listenerOptions)).rejects.toThrow("not opened");
    expect(open).toHaveBeenLastCalledWith(
      expect.objectContaining({ livenessSeconds: 10, url: URL }),
    );
    await connection.onDestroy();
  });

  it("AC4: a settings object that was unset when built stays on the default", async () => {
    const open = vi.spyOn(PostgresListener, "open").mockRejectedValue(new Error("not opened"));
    const settings: { url: string; watchLivenessSeconds?: number } = { url: URL };
    const connection = new PostgresConnection(settings);
    settings.watchLivenessSeconds = 2_147_484;

    await expect(listenerOf(connection, listenerOptions)).rejects.toThrow("not opened");
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ livenessSeconds: 10 }));
    await connection.onDestroy();
  });
});

describe("agbossjs/agboss#1129: the URL's connect_timeout has an upper limit", () => {
  it("AC5: the limit itself is the bound, in ms", () => {
    expect(connectTimeoutOf(`${URL}?connect_timeout=3600`)).toBe(3_600_000);
  });

  it.each(["3601", "2147484", "2147483648", "999999999"])(
    "AC5: connect_timeout=%s fails with PostgresSettingsError naming the field, without printing the URL",
    (value) => {
      const failure = (): unknown => connectTimeoutOf(`${URL}?connect_timeout=${value}`);
      expect(failure).toThrow(PostgresSettingsError);
      expect(failure).toThrow(
        "the URL's connect_timeout must be a whole number of seconds, at most 3600",
      );
      expect(failure).not.toThrow(/secret@db/u);
    },
  );

  it.each(["settings", "resolved"] as const)(
    "AC5: a connection built from %s on such a URL is refused at construction",
    (path) => {
      const url = `${URL}?connect_timeout=2147484`;
      const build = (): unknown =>
        new PostgresConnection(path === "settings" ? { url } : resolved(10, url));
      expect(build).toThrow(PostgresSettingsError);
      expect(build).toThrow(/connect_timeout must be a whole number of seconds, at most 3600/);
    },
  );
});

const listenerOptions: Parameters<typeof listenerOf>[1] = {
  channel: "c",
  payload: "p",
  clock: undefined as never,
  warn: () => undefined,
  onNotify: () => undefined,
};
