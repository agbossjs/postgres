import { secret } from "@agboss/core";
import type { StopEnvironment } from "./stop.contract.js";

/** The stop tests' database (the test names it) and a pool of 4. */
export const environment: StopEnvironment = {
  postgresUrl: secret("AGBOSS_STOP_DATABASE_URL"),
  postgresPoolSize: 4,
  openRouterApiKey: secret("AGBOSS_STOP_OPENROUTER_KEY"),
};
