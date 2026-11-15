import { PostgresSettingsError } from "../errors.js";

/**
 * How long, in ms, a statement waits for its connection — a free one of the pool, or a new one up
 * to the server's first answer — when the URL sets no `connect_timeout` (agbossjs/agboss#989): a
 * peer that takes the socket and never answers (a black-holed network, a proxy that drops the
 * forward, a socket connected to itself) fails the call with `pg`'s connection timeout instead of
 * hanging it forever. A third of the core's 30 s lease. The command timeout of every statement
 * (agbossjs/agboss#928) is another bound, independent of this one.
 */
export const DEFAULT_CONNECT_TIMEOUT = 10_000;

/**
 * The longest `connect_timeout` the URL may set, in seconds (agbossjs/agboss#1129): an hour, far
 * under the 2^31-1 ms a Node timer holds — beyond it `pg`'s timer fires at once.
 */
export const MAX_CONNECT_TIMEOUT_SECONDS = 3600;

/**
 * The connect bound of `url`, in ms: its `connect_timeout` (libpq's parameter, whole seconds —
 * which `pg` itself ignores), else `DEFAULT_CONNECT_TIMEOUT`; libpq reads `1` as 2 s, so does this.
 * `0` ("wait forever"), a negative value, anything but a whole number of seconds and one above
 * `MAX_CONNECT_TIMEOUT_SECONDS` fail with `PostgresSettingsError` (agbossjs/agboss#928, #1129): a
 * store never waits forever. The URL itself is never printed.
 */
export function connectTimeoutOf(url: string): number {
  const text = urlParameterOf(url, "connect_timeout");
  if (text === undefined) return DEFAULT_CONNECT_TIMEOUT;
  if (!/^[1-9]\d{0,8}$/u.test(text.trim()))
    throw new PostgresSettingsError({
      message: "the URL's connect_timeout must be a whole number of seconds, at least 1",
    });
  const seconds = Number(text.trim());
  if (seconds > MAX_CONNECT_TIMEOUT_SECONDS)
    throw new PostgresSettingsError({
      message: `the URL's connect_timeout must be a whole number of seconds, at most ${String(MAX_CONNECT_TIMEOUT_SECONDS)}`,
    });
  return Math.max(seconds, 2) * 1000;
}

/** A query parameter of a `postgres://` URL; `undefined` for none, or for a URL that does not parse. */
function urlParameterOf(url: string, name: string): string | undefined {
  try {
    return new URL(url).searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}
