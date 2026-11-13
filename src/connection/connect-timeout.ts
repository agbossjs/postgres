import { PostgresSettingsError } from "../errors.js";

/**
 * How long, in ms, a statement waits for its connection — a free one of the pool, or a new one up
 * to the server's first answer — when the URL sets no `connect_timeout` (agbossjs/agboss#989): a
 * peer that takes the socket and never answers (a black-holed network, a proxy that drops the
 * forward, a socket connected to itself) fails the call with `pg`'s connection timeout instead of
 * hanging it forever. A third of the core's 30 s lease; agbossjs/agboss#928 adds the command
 * timeout of every statement after it.
 */
export const DEFAULT_CONNECT_TIMEOUT = 10_000;

/**
 * The connect bound of `url`, in ms: its `connect_timeout` (libpq's parameter, whole seconds —
 * which `pg` itself ignores), else `DEFAULT_CONNECT_TIMEOUT`. libpq's `0` ("wait forever") keeps
 * the default: a store's connection never waits forever. Anything but a whole number fails with
 * `PostgresSettingsError`; the URL itself is never printed.
 */
export function connectTimeoutOf(url: string): number {
  const text = urlParameterOf(url, "connect_timeout");
  if (text === undefined) return DEFAULT_CONNECT_TIMEOUT;
  if (!/^\d{1,9}$/u.test(text.trim()))
    throw new PostgresSettingsError({
      message: "the URL's connect_timeout must be a whole number of seconds",
    });
  const seconds = Number(text.trim());
  return seconds === 0 ? DEFAULT_CONNECT_TIMEOUT : seconds * 1000;
}

/** A query parameter of a `postgres://` URL; `undefined` for none, or for a URL that does not parse. */
function urlParameterOf(url: string, name: string): string | undefined {
  try {
    return new URL(url).searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}
