import type { Secret } from "@agboss/core";

/** The environment the stop tests' application reads: the PostgreSQL connection's fields. */
export class StopEnvironment {
  postgresUrl!: Secret;
  postgresPoolSize?: number;
  /** The built-in model provider's key: a placeholder, the workflows call no model. */
  openRouterApiKey!: Secret;
}
