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
      "tests/stores/{fenced-effect*,outbound-call*,stored-not-json-fenced,key-text.property}.test.ts",
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
      "tests/stores/{cost-ledger*,rate-limit*,child-execution-queue*}.test.ts",
      // the child queue's watch: its wake-ups, its close, the warning of a connection lost
      "tests/connection/{listener,listener-silent-death,listener-close-reopen}.test.ts",
    ],
    testNamePattern: conformanceOf(
      "cost ledger contract",
      "rate limit contract",
      "child execution queue contract",
    ),
  },
  // the child queue's watch (agbossjs/agboss#777, #789, #954; agbossjs/postgres#127): the LISTEN
  // connection of its own, its reconnect with the doubling pause, the wake-up once it listens
  // again, the liveness ping of a half-open connection, the drop of a connection at once, and
  // the close that never waits on a silent server
  "queue-watch": {
    mutate: ["src/connection/{listener,heartbeat,drop-client}.ts"],
    tests: [
      "tests/connection/{listener*,heartbeat,drop-client}.test.ts",
      "tests/connection/watch-liveness-*.test.ts",
    ],
  },
  // the direct reply of an A2A message (agbossjs/agboss#860): of two pods accepting one message
  // exactly one claims it, and only the attempt that holds it completes or frees it; an attempt
  // is retaken only once its `expires_at` has passed (agbossjs/postgres#129 acceptance)
  "a2a-direct": {
    mutate: [
      "src/stores/postgres-a2a-direct-message.repository.ts",
      "src/stores/a2a-direct-messages/*.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/a2a-direct-message{,-clauses}.test.ts"],
    testNamePattern: conformanceOf("A2A direct message contract"),
  },
  // the checkpoint saver (agbossjs/agboss#1165): the latest checkpoint of a thread by its step,
  // and the version a branch of one checkpoint gets, which its blobs rely on
  checkpoints: {
    mutate: ["src/stores/postgres-checkpoint-saver.ts"],
    tests: [CONFORMANCE, "tests/stores/{checkpoint-saver,checkpoint-latest-by-step}.test.ts"],
    testNamePattern: conformanceOf("checkpoint saver contract"),
  },
  // the schema: the migrations, their history and its check, the checkpoint tables, the live-lease
  // guard of an upgrade and a migrating start's wait for leases to lapse (agbossjs/agboss#1104)
  migrations: {
    mutate: ["src/migrations/*.ts"],
    tests: ["tests/migrations/*.test.ts", "tests/cli/*.test.ts"],
  },
  // every store call bounded (agbossjs/agboss#928, #1064): the command timeout, the outcome of a
  // call whose answer was lost, the transaction, the stored texts read back, the pool's clients
  // whose socket is ours to drop (#954) and the memo of a start that may be asked again
  // (agbossjs/postgres#129)
  "store-bound": {
    mutate: [
      "src/connection/{outcome,known-failure,timed-client,timed-pool,transaction,query,connect-timeout,pool-options,tracked-client,once}.ts",
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

/**
 * The files of `src/` no shard mutates, each group with its reason (agbossjs/postgres#129):
 * `tests/scripts/mutation-shards-complete.test.ts` fails for a file that is in a shard's `mutate`
 * and here, and for one that is in neither, so a new module gets a conscious assignment.
 */
export const NON_SHARDED_SRC = new Set([
  // the public surface and the types: no behaviour a mutant could change
  "src/index.ts",
  "src/errors.ts",
  // the command line (its own tests, tests/cli) and the wiring of a connection and its stores
  // from the settings: no money-path decision
  "src/cli.ts",
  "src/connection/postgres-connection.ts",
  "src/connection/settings.ts",
  "src/store-bundles.ts",
  "src/redaction.ts",
  // Not sharded yet, each with the guarantee it holds that a mutation run does not prove (the
  // contracts exercise them; agbossjs/postgres#133 shards them, and each line goes with its shard):
  // - the A2A task store (agbossjs/agboss#824): `compareAndSetStatus` is one `UPDATE … WHERE
  //   version = $n AND state NOT IN (terminal)`, `saveIfAbsent` accepts a message once, and the
  //   message claim (`a2a-task-rows.ts`, `a2a-task-statements.ts`) is the one the direct-message
  //   store shares; core mutates its own twin in its `a2a-tasks` shard
  "src/stores/postgres-a2a-task.repository.ts",
  "src/stores/a2a-tasks/a2a-task-pages.ts",
  "src/stores/a2a-tasks/a2a-task-rows.ts",
  "src/stores/a2a-tasks/a2a-task-statements.ts",
  // - the mesh request store (agbossjs/agboss#483): one `INSERT … ON CONFLICT DO NOTHING` decides
  //   which pod runs a retried request
  "src/stores/postgres-mesh-request.repository.ts",
  // - the execution tree store: `saveIfAbsentInTree` has one winner per key
  "src/stores/postgres-execution-tree.repository.ts",
  // - the execution record store: `completeIfStatus` is a compare-and-set, the late status write
  //   that must not land; a thread is created once and the first answer of a pause is kept
  //   (`ON CONFLICT DO NOTHING`); the rows, reads, scores and memory are its other statements
  "src/stores/postgres-execution-record.repository.ts",
  "src/stores/records/record-memory.ts",
  "src/stores/records/record-reads.ts",
  "src/stores/records/record-rows.ts",
  "src/stores/records/record-scores.ts",
  "src/stores/records/record-writes.ts",
  // No compare-and-set, claim or once-only write in these two, so no guarantee of the bar to
  // mutate: the audit log is an append-only `INSERT` read back in the order of its time and its
  // identity, and the history is a last-write-wins upsert read by period; their order and paging
  // are read by the contracts and tests/stores, and a shard would be worth it only for those reads
  "src/stores/postgres-execution-audit-log.repository.ts",
  "src/stores/audit-log/audit-event-rows.ts",
  "src/stores/postgres-execution-history.repository.ts",
  "src/stores/history/history-rows.ts",
]);

/** The shard `MUTATION_SHARD` names (default `fencing`); a name of none fails. */
export function chosenShard() {
  const name = process.env.MUTATION_SHARD ?? "fencing";
  const shard = SHARDS[name];
  if (shard === undefined)
    throw new Error(`MUTATION_SHARD: "${name}" is none of ${Object.keys(SHARDS).join(", ")}`);
  return { name, ...shard };
}
