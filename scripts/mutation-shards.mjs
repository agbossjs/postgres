/**
 * The mutation shards of this package (agbossjs/agboss#1213, as the core's stryker.config.mjs,
 * #533 item 3, #626): each the money-path modules it mutates and the tests that must kill them.
 * Read by `stryker.config.mjs` (what to mutate) and `vitest.mutation.config.ts` (what to run);
 * `MUTATION_SHARD` picks one. The tests need `AGBOSS_POSTGRES_TEST_URL`, as every test here.
 */
const CONFORMANCE = "tests/contracts/store-conformance.test.ts";
/**
 * Only these suites of the store contracts, and every case of the shard's other files: the
 * contracts of the other shards' stores take most of a run and kill none of its mutants.
 */
const conformanceOf = (...suites) =>
  String.raw`(${suites.join("|")}) \(PostgreSQL\)|^(?!.*\(PostgreSQL\))`;

export const SHARDS = {
  // the lease in SQL: epochs, expiry, finish, yield and reclaim, the database's own clock, the
  // tree's durable cancel mark (agbossjs/agboss#909, #1117, #1152) and the fence every fencing
  // write checks in its own transaction
  fencing: {
    mutate: [
      "src/stores/postgres-execution-lease.repository.ts",
      "src/stores/fence.ts",
      "src/stores/cancel-fence.ts",
      "src/stores/outbound-calls/lease-state.ts",
      "src/stores/store-time.ts",
    ],
    tests: [
      CONFORMANCE,
      "tests/contracts/explorer-bites-*.test.ts",
      "tests/stores/{execution-lease*,cancel-fence,fence-mark,clock-authority,database-time,acceptance-*,minted-thread}.test.ts",
    ],
  },
  // the fenced effect and the outbound call: one effect per key, the business key's fingerprint,
  // the intent, its attempts and outcomes, the paged listing
  "effects-and-calls": {
    mutate: [
      "src/stores/postgres-fenced-effect.repository.ts",
      "src/stores/key-entry.ts",
      "src/stores/postgres-outbound-call.repository.ts",
      "src/stores/outbound-calls/outbound-call-rows.ts",
      "src/stores/outbound-call-pages.ts",
    ],
    tests: [
      CONFORMANCE,
      "tests/stores/{fenced-effect,outbound-call*,stored-not-json-fenced,key-text.property}.test.ts",
    ],
    testNamePattern: conformanceOf(
      "fenced effect contract",
      "outbound call contract",
      "interleavings",
      "store set",
    ),
  },
  // the pause store: decisions, answers, notices and their claims (agbossjs/agboss#946), deadlines
  // and their timers (#941, #1064), reassignment
  pauses: {
    mutate: [
      "src/stores/postgres-paused-execution.repository.ts",
      "src/stores/postgres-paused-runs.repository.ts",
      "src/stores/postgres-pause-queries.repository.ts",
      "src/stores/paused/*.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/{pause*,paused*}.test.ts"],
    testNamePattern: conformanceOf("paused execution contract"),
  },
  // money and its limits: the cost ledger, the rate limits, the child queue
  money: {
    mutate: [
      "src/stores/postgres-cost-ledger.repository.ts",
      "src/stores/postgres-rate-limit.repository.ts",
      "src/stores/rate-limits/*.ts",
      "src/stores/postgres-child-execution-queue.repository.ts",
    ],
    tests: [
      CONFORMANCE,
      "tests/stores/{cost-ledger,rate-limit,child-execution-queue}.test.ts",
      // the child queue's watch: its wake-ups, its close, the warning of a connection lost
      "tests/connection/{listener,listener-silent-death,listener-close-reopen}.test.ts",
    ],
    testNamePattern: conformanceOf(
      "cost ledger contract",
      "rate limit contract",
      "child execution queue contract",
    ),
  },
  // the schema: the migrations, their history and its check, the checkpoint tables, the live-lease
  // guard of an upgrade and a migrating start's wait for leases to lapse (agbossjs/agboss#1104)
  migrations: {
    mutate: ["src/migrations/*.ts"],
    tests: ["tests/migrations/*.test.ts", "tests/cli/*.test.ts"],
  },
  // every store call bounded (agbossjs/agboss#928, #1064): the command timeout, the outcome of a
  // call whose answer was lost, the transaction, and the stored texts read back
  "store-bound": {
    mutate: [
      "src/connection/{outcome,known-failure,timed-client,timed-pool,transaction,query,connect-timeout,pool-options}.ts",
      "src/stores/{unreadable,framework-json,nul-escape}.ts",
    ],
    tests: [
      "tests/connection/*.test.ts",
      "tests/stores/{stored-not-json*,nul-escape,framework-json*,unreadable*}.test.ts",
    ],
    // they start and pause a server of their own: not one per mutant
    exclude: ["tests/connection/close-quiet-*.test.ts"],
  },
};

/** The shard `MUTATION_SHARD` names (default `fencing`); a name of none fails. */
export function chosenShard() {
  const name = process.env.MUTATION_SHARD ?? "fencing";
  const shard = SHARDS[name];
  if (shard === undefined)
    throw new Error(`MUTATION_SHARD: "${name}" is none of ${Object.keys(SHARDS).join(", ")}`);
  return { name, ...shard };
}
