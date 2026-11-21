import { chosenShard } from "./scripts/mutation-shards.mjs";

/**
 * Mutation testing of the money-path modules (agbossjs/agboss#1213, the core's #533 item 3, #626):
 * every mutant is killed by a test or justified in writing where it stands (a `Stryker disable`
 * comment naming only the mutators whose every mutant on its line is equivalent, with the reason,
 * the core's #619). The score is gated (`thresholds.break` 100). One shard per run, its own
 * incremental file (`reports/stryker-incremental-<shard>.json`, cached by CI per shard).
 * Locally: `MUTATION_SHARD=<shard> npm run test:mutation` (3 workers at most), with the servers
 * of `npm run coverage` set.
 */
const shard = chosenShard();

export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts" },
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: shard.mutate,
  coverageAnalysis: "perTest",
  concurrency: 3,
  incremental: true,
  incrementalFile: `reports/stryker-incremental-${shard.name}.json`,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: `reports/mutation/${shard.name}.json` },
  thresholds: { high: 100, low: 95, break: 100 },
  timeoutMS: shard.timeoutMS,
  // agbossjs/agboss#1367: x the covering tests' net time, beside timeoutMS (scripts/mutation-shards.mjs)
  timeoutFactor: 3,
  // the initial run is the shard's whole suite on the real server (the store contracts alone take
  // about 4 min): the default 5 min is too short on a loaded machine
  dryRunTimeoutMinutes: 20,
  // another shard's sandbox, left by an interrupted run, is no source of this one
  ignorePatterns: [".stryker-tmp-*", "reports"],
  tempDirName: `.stryker-tmp-${shard.name}`,
};
