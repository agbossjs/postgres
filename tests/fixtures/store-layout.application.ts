import { Application, DatabaseStorage, secret, type Class, type Provider } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { PostgresDriver } from "../../src/index.js";
import { TakeoverWorkflow } from "./takeover.workflow.js";
import {
  ProcessApplicationBudget,
  ProcessExecutionBudget,
  ProcessTenantBudget,
} from "./process.application.js";

/**
 * An application of the takeover workflow on the given stores, listed one by one in `providers` (no
 * `@DatabaseStorage`) — a layout of `tests/processes/store-backends.test.ts` (agbossjs/agboss#526
 * AC1), with no model to call (no key to read). It is only assembled (`describeApplication`), never
 * started: a store of the package reads its connection from the application's storage, and a layout
 * with the stores listed has none (a started one is `storageLayoutOf`).
 */
export function storeLayoutOf(providers: readonly Provider[]): Class {
  @Application({
    name: "store-layout-application",
    version: "1.0.0",
    workflows: [TakeoverWorkflow],
    budgets: [ProcessApplicationBudget, ProcessTenantBudget, ProcessExecutionBudget],
    providers: [...providers],
  })
  class StoreLayoutApplication {}
  return StoreLayoutApplication;
}

/** Every store on PostgreSQL through the driver (`AGBOSS_PROCESS_DATABASE_URL`), a pool of 4. */
@DatabaseStorage({
  name: "store-layout-database-storage",
  description: "The store layouts' PostgreSQL",
  driver: PostgresDriver({ url: secret("AGBOSS_PROCESS_DATABASE_URL"), poolSize: 4 }),
  auditLogTtl: hours(24),
  ledgerEntriesTtl: hours(24),
  // a workflow that can write under a business key needs the key its fingerprints are made with (#825)
  idempotencySecret: secret("AGBOSS_PROCESS_IDEMPOTENCY_KEY"),
})
class StoreLayoutDatabaseStorage {}

/**
 * The takeover workflow on the package's `PostgresDriver` stores, started: the application lists no
 * store itself (`[storage.providers-conflict]`), only what is not one — a project's own id
 * generator, say, in `providers`; `workflows` are the ones it runs (the takeover workflow by default).
 */
export function storageLayoutOf(
  providers: readonly Provider[] = [],
  workflows: readonly Class[] = [TakeoverWorkflow],
): Class {
  @Application({
    name: "storage-layout-application",
    version: "1.0.0",
    storage: StoreLayoutDatabaseStorage,
    workflows: [...workflows],
    budgets: [ProcessApplicationBudget, ProcessTenantBudget, ProcessExecutionBudget],
    providers: [...providers],
  })
  class StorageLayoutApplication {}
  return StorageLayoutApplication;
}
