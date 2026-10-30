/**
 * agbossjs/agboss#511 AC3: `PostgresConnection` declares the environment fields it reads
 * (`environmentFields`), so an application that lists a PostgreSQL store without `postgresUrl` in
 * its environment contract fails at assembly with `[environment.missing-field]`, naming the field,
 * the store and the connection — before any connection is built, as `sqlitePath` does. The
 * assembly reports every violation at once, so an application with no workflow shows its
 * environment's violations too.
 */
import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  createApp,
  GraphRuleError,
  type BudgetHandler,
  type Secret,
} from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";

@Budget({
  name: "probe-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
class ProbeApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "probe-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
class ProbeTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "probe-execution-budget", scope: BudgetScope.Execution })
class ProbeExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

/** A contract without the connection's fields. */
class UrllessEnvironment {
  region!: string;
}

/** A contract with the required field; the optional ones absent. */
class PostgresEnvironment {
  postgresUrl!: Secret;
}

const BUDGETS = [ProbeApplicationBudget, ProbeTenantBudget, ProbeExecutionBudget];

@Application({
  name: "urlless-application",
  version: "1.0.0",
  environment: UrllessEnvironment,
  workflows: [],
  providers: [PostgresExecutionLeaseRepository],
  budgets: BUDGETS,
})
class UrllessApplication {}

@Application({
  name: "postgres-application",
  version: "1.0.0",
  environment: PostgresEnvironment,
  workflows: [],
  providers: [PostgresExecutionLeaseRepository],
  budgets: BUDGETS,
})
class PostgresApplication {}

/** The assembly's violations of the environment contract, as `[code] message`. */
async function environmentViolationsOf(application: new () => object): Promise<string[]> {
  const error: unknown = await createApp(application, { env: "test" }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError)) throw new Error("expected the assembly to fail");
  return error.violations
    .filter((found) => found.code.startsWith("environment."))
    .map((found) => `[${found.code}] ${found.message}`);
}

describe("agbossjs/agboss#511 AC3: postgresUrl is checked at assembly", () => {
  it("AC3: a PostgreSQL store listed without postgresUrl in the contract → [environment.missing-field]", async () => {
    expect(await environmentViolationsOf(UrllessApplication)).toEqual([
      "[environment.missing-field] PostgresExecutionLeaseRepository needs postgresUrl: Secret in UrllessEnvironment (read by PostgresConnection)",
    ]);
  });

  it("AC3: postgresPoolSize and postgresMigrateOnStart are optional: absent, no violation", async () => {
    expect(await environmentViolationsOf(PostgresApplication)).toEqual([]);
  });
});
