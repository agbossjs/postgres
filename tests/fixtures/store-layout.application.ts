import { Application, type Class } from "@agboss/core";
import { PostgresConnection } from "../../src/index.js";
import { OfflineClerkModelProvider } from "./approval.workflow.js";
import { ChargeWorkflow } from "./charge.workflow.js";
import { ProcessEnvironment } from "./environments/app.environment.js";
import {
  ProcessApplicationBudget,
  ProcessExecutionBudget,
  ProcessTenantBudget,
} from "./process.application.js";

/**
 * An application of the charge workflow (an outbound call) on the given stores — a layout of
 * `tests/processes/store-backends.test.ts` (agbossjs/agboss#526 AC1), on the `process`
 * environment, with an offline model provider (no key to read). It lists `PostgresConnection` only because the charge action injects it itself:
 * the stores no longer need it listed (#526 AC8).
 */
export function storeLayoutOf(providers: readonly Class[]): Class {
  @Application({
    name: "store-layout-application",
    version: "1.0.0",
    environment: ProcessEnvironment,
    workflows: [ChargeWorkflow],
    budgets: [ProcessApplicationBudget, ProcessTenantBudget, ProcessExecutionBudget],
    providers: [OfflineClerkModelProvider, PostgresConnection, ...providers],
  })
  class StoreLayoutApplication {}
  return StoreLayoutApplication;
}
