import { fileURLToPath } from "node:url";
import { FAULT_SCENARIOS, type FaultSuiteOptions } from "@agboss/core/testing/faults";
import { afterAll } from "vitest";
import { migratePostgres } from "../../src/index.js";
import { createSchema, dropSchema, onSchema } from "../support/database.js";
import { FAULT_BUSINESS_ROWS_DDL } from "./postgres.fault-stores.js";

/**
 * agbossjs/agboss#484 — the fault suite's PostgreSQL target: before each scenario a schema of its
 * own on `AGBOSS_POSTGRES_TEST_URL`, migrated, with the fixture's business table; every schema
 * dropped after the file. The pods reach it through a proxy each (its URL has a host and a port).
 *
 * Time is the real clock, on every run (agbossjs/agboss#607). PostgreSQL decides a lease's expiry by
 * its own `clock_timestamp()` (agbossjs/agboss#533), at the real rate: a pod whose clock ran faster
 * would ask for a 30 s lease that the database keeps for 30 real seconds while the scenario waits
 * for a takeover on the pod's scale (s05c, s05d time out at 10), and shrinking the durations the pod
 * sends would put the 1 s safety margin and the clock-rate bound (ρ ≤ 1 s / 30 s) under the CI
 * runner's jitter — the store and the checker would no longer test the lease the core ships. So the
 * pods run at 1, and CI shards the scenarios over parallel jobs (`AGBOSS_FAULT_SHARD`, `k/n`) to fit.
 */

/** The store set's module, imported by every pod. */
export const POSTGRES_FAULT_STORES = fileURLToPath(
  new URL("./postgres.fault-stores.ts", import.meta.url),
);

/** One shard of the scenarios: `k/n` (1 ≤ k ≤ n), every `n`-th from the `k`-th, in the suite's order. */
export interface FaultShard {
  readonly index: number;
  readonly count: number;
}

/** The shard `text` names (`AGBOSS_FAULT_SHARD`); `undefined` for none, a `RangeError` when malformed. */
export function faultShardOf(text: string | undefined): FaultShard | undefined {
  if (text === undefined || text === "") return undefined;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text);
  const [index, count] = [Number(match?.[1]), Number(match?.[2])];
  if (match === null || index > count)
    throw new RangeError(`AGBOSS_FAULT_SHARD is "${text}": expected k/n with 1 ≤ k ≤ n`);
  return { index, count };
}

/** The ids of the scenarios of `shard` (every scenario without one). */
export function scenariosOf(shard: FaultShard | undefined): readonly string[] | undefined {
  if (shard === undefined) return undefined;
  return FAULT_SCENARIOS.filter((_, at) => at % shard.count === shard.index - 1).map(
    (scenario) => scenario.id,
  );
}

/** The fault suite's options on fresh schemas of this file's own, on the real clock. */
export function postgresFaultTarget(): FaultSuiteOptions {
  const schemas: string[] = [];
  let url = "";
  afterAll(async () => {
    for (const schema of schemas) await dropSchema(schema);
  });
  return {
    name: "PostgreSQL",
    stores: POSTGRES_FAULT_STORES,
    // the pods and PostgreSQL's `clock_timestamp()` at one rate: the lease, its margin and the
    // linearizability checker's times are the core's own (see above)
    timeScale: 1,
    storeTimeScale: 1,
    scenarios: scenariosOf(faultShardOf(process.env.AGBOSS_FAULT_SHARD)),
    database: {
      get url() {
        return url;
      },
      reset: async () => {
        const created = await createSchema();
        schemas.push(created.schema);
        await migratePostgres({ url: created.url });
        await onSchema(created.url, FAULT_BUSINESS_ROWS_DDL);
        url = created.url;
      },
    },
  };
}
