import { secret } from "@agboss/core";
import type { ProcessEnvironment } from "./app.environment.js";

/** A process of tests/processes/: the test's schema (`AGBOSS_PROCESS_DATABASE_URL`), a pool of 4. */
export const environment: ProcessEnvironment = {
  postgresUrl: secret("AGBOSS_PROCESS_DATABASE_URL"),
  postgresPoolSize: 4,
};
