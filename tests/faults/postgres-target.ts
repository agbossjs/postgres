import { fileURLToPath } from "node:url";
import type { FaultSuiteOptions } from "@agboss/core/testing/faults";
import { afterAll } from "vitest";
import { migratePostgres } from "../../src/index.js";
import { createSchema, dropSchema, onSchema } from "../support/database.js";
import { FAULT_BUSINESS_ROWS_DDL } from "./postgres.fault-stores.js";

/**
 * agbossjs/agboss#484 — the fault suite's PostgreSQL target: before each scenario a schema of its
 * own on `AGBOSS_POSTGRES_TEST_URL`, migrated, with the fixture's business table; every schema
 * dropped after the file. The pods reach it through a proxy each (its URL has a host and a port).
 * Time is the real clock unless `AGBOSS_FAULT_TIME_SCALE` says otherwise (CI's pull requests run
 * faster, the nightly run and pushes to main at 1).
 */

/** The store set's module, imported by every pod. */
export const POSTGRES_FAULT_STORES = fileURLToPath(
  new URL("./postgres.fault-stores.ts", import.meta.url),
);

/** The suite's time scale: `AGBOSS_FAULT_TIME_SCALE`, else the real clock. */
const timeScale = (): number => Number(process.env.AGBOSS_FAULT_TIME_SCALE ?? "1") || 1;

/** The fault suite's options on fresh schemas of this file's own. */
export function postgresFaultTarget(): Omit<FaultSuiteOptions, "scenarios"> {
  const schemas: string[] = [];
  let url = "";
  afterAll(async () => {
    for (const schema of schemas) await dropSchema(schema);
  });
  return {
    name: "PostgreSQL",
    stores: POSTGRES_FAULT_STORES,
    timeScale: timeScale(),
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
