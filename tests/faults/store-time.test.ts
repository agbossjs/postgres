import { faultSuite } from "@agboss/core/testing/faults";
import { postgresFaultTarget } from "./postgres-target.js";

/**
 * agbossjs/agboss#971 AC2 — the store-time declaration, checked on every run of CI's `faults` job:
 * one scenario (1, the cheapest) with the shipped PostgreSQL stores and the pods running 5 times faster,
 * whatever the job's `AGBOSS_FAULT_TIME_SCALE` (1 at pushes to main and nightly, where the pods'
 * clock and the real one are the same and no declaration can be told wrong). At scale 5 the suite's probe
 * measures the stores' clock against the pods': a `storeTime` the stores contradict — `Host` on a
 * set that decides by the database's `clock_timestamp()`, or the reverse — fails `[fault-suite.store-time-mismatch]` before the
 * scenario starts.
 */
faultSuite({
  ...postgresFaultTarget(),
  timeScale: 5,
  // the one scenario in every shard of CI's job (AGBOSS_FAULT_SHARD would leave two of three with none)
  shard: { index: 1, count: 1 },
  scenarios: ["s01-sigterm-drains"],
  sabotages: false,
});
