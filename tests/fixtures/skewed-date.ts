/**
 * agbossjs/agboss#533 AC4 — a process whose clock is off: imported first by `instance.ts`, it
 * stubs `Date` (`Date.now()` and `new Date()`) `AGBOSS_CLOCK_OFFSET_MS` ahead (negative: behind) of
 * the host's, running `AGBOSS_CLOCK_DRIFT` faster (0.01: 1 % fast) — and `performance.now()` at the
 * same rate, the monotonic clock a lease's holder fences itself with. Every time the process's
 * framework reads goes through these, as on a host whose clock is wrong; the database keeps its own.
 */
const offset = Number(process.env.AGBOSS_CLOCK_OFFSET_MS ?? "0");
const drift = Number(process.env.AGBOSS_CLOCK_DRIFT ?? "0");

if (offset !== 0 || drift !== 0) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  const origin = realNow();
  const rate = 1 + drift;
  const skewedNow = (): number => origin + offset + (realNow() - origin) * rate;
  class SkewedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0) super(skewedNow());
      else super(...args);
    }

    static override now(): number {
      return skewedNow();
    }
  }
  globalThis.Date = SkewedDate as DateConstructor;
  const realPerformanceNow = performance.now.bind(performance);
  const monotonicOrigin = realPerformanceNow();
  performance.now = () => monotonicOrigin + (realPerformanceNow() - monotonicOrigin) * rate;
}

export {};
