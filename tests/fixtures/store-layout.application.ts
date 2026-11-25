import { Application, EmptyEnvironment, type Class, type Provider } from "@agboss/core";
import { TakeoverWorkflow } from "./takeover.workflow.js";
import {
  ProcessApplicationBudget,
  ProcessExecutionBudget,
  ProcessTenantBudget,
} from "./process.application.js";

/**
 * An application of the takeover workflow on the given stores, listed one by one in `providers` (no
 * `@DatabaseStorage`) — a layout of `tests/processes/store-backends.test.ts` (agbossjs/agboss#526
 * AC1), with no model to call (no key to read). The workflow writes no business key, so no
 * idempotency secret is needed; the stores' connection settings are the process's variables.
 */
export function storeLayoutOf(providers: readonly Provider[]): Class {
  @Application({
    name: "store-layout-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [TakeoverWorkflow],
    budgets: [ProcessApplicationBudget, ProcessTenantBudget, ProcessExecutionBudget],
    providers: [...providers],
  })
  class StoreLayoutApplication {}
  return StoreLayoutApplication;
}
