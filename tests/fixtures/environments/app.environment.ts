import type { Secret } from "@agboss/core";

/** The process application's environment contract: the PostgreSQL stores' fields. */
export class ProcessEnvironment {
  postgresUrl!: Secret;
  postgresPoolSize?: number;
}
