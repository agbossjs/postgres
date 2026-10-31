import type { StoreClock } from "@agboss/core";

/**
 * The time a statement decides a lease by (agbossjs/agboss#533): the database's own,
 * `clock_timestamp()` — read inside the statement, where it is evaluated, after any row lock it
 * waited for — so every instance agrees on a lease's expiry whatever its wall clock says; or, when a
 * test injected its clock (`StoreClock.isDatabaseTime` false), that clock's time as a parameter, so
 * the contract suites can move it. One SQL shape for both: `COALESCE($n::timestamptz,
 * clock_timestamp())`, the parameter `null` in production.
 */
export const storeNow = (parameter: number): string =>
  `COALESCE($${String(parameter)}::timestamptz, clock_timestamp())`;

/** The value of `storeNow`'s parameter: `null` (the database's time), or the test's clock now. */
export const storeNowOf = (clock: StoreClock): Date | null =>
  clock.isDatabaseTime ? null : clock.now();

/** The whole milliseconds (rounded down) from `now` to `expires`, as SQL: what a lease has left. */
export const remainingSql = (expires: string, now: string): string =>
  `floor(extract(epoch FROM (${expires} - ${now})) * 1000)::float8`;
