/**
 * The mutation shards of this package (agbossjs/agboss#1213, as the core's stryker.config.mjs,
 * #533 item 3, #626): each the money-path modules it mutates and the tests that must kill them.
 * Read by `stryker.config.mjs` (what to mutate) and `vitest.mutation.config.ts` (what to run);
 * `MUTATION_SHARD` picks one. The tests need `AGBOSS_POSTGRES_TEST_URL`, as every test here.
 */
const CONFORMANCE = "tests/contracts/store-conformance.test.ts";
/**
 * `timeoutMS` of a shard and the `timeoutFactor` of `stryker.config.mjs` (agbossjs/agboss#1367, agbossjs/mongodb#103):
 * Stryker's limit for one mutant is `timeoutFactor` x the net time of the tests that cover it + `timeoutMS`; a static
 * mutant, or one every test covers, has the net time of the whole shard, and the net time leaves out hooks and setup
 * (the dry run's "overhead"). A mutant no test kills then outlasted the old limit (1.5 x + 20 s), read as a
 * Timeout, and a Timeout counts as killed: a survivor hid in the score. The dry run is one worker alone, the
 * mutants run three at once, so a mutant's run takes up to 3 x the dry run's: the factor is 3 and `timeoutMS` is 3 x
 * the shard's overhead on CI (nightly and main runs of 2026-11-20), 120 s at least, so the limit is 3 x the whole run.
 * A Timeout is then a hang, and `scripts/stryker-timeouts.mjs` fails a job on one not in
 * `scripts/stryker-proven-hangs.json`. A hang of an async test stays vitest's (`testTimeout`, `hookTimeout` of
 * `vitest.mutation.config.ts`). A new shard needs one: read "Initial test run succeeded. Ran N tests in X seconds
 * (net Y ms, overhead Z ms)" and set 3 x Z, rounded up to 10 s, 120 s at least (a hung async test takes about 60 s to be ended by vitest, test then hooks: a lower limit read such a mutant as a Timeout in one run and Killed in the next). The contracts of the store
 * conformance a shard needs are picked in `tests/contracts/mutation-contracts.ts`, never by a `testNamePattern`
 * here: vitest keeps a config's pattern as an override of the pattern Stryker sets for each mutant's covering
 * tests, so every mutant ran every test of the shard.
 */
export const SHARDS = {
  // the lease in SQL: epochs, expiry, finish, yield and reclaim, the database's own clock, the
  // tree's durable cancel mark (agbossjs/agboss#909, #1117, #1152) and the fence every fencing
  // write checks in its own transaction
  fencing: {
    timeoutMS: 120_000,
    mutate: [
      "src/stores/postgres-execution-lease.repository.ts",
      "src/stores/postgres-lease-marks.repository.ts",
      "src/stores/lease-marks.ts",
      "src/stores/status-log.ts",
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
    timeoutMS: 120_000,
    mutate: [
      "src/stores/postgres-fenced-effect.repository.ts",
      "src/connection/ambient.ts",
      "src/stores/outbound-calls/outbound-call-lookup.ts",
      "src/stores/key-entry.ts",
      "src/stores/postgres-outbound-call.repository.ts",
      "src/stores/outbound-calls/outbound-call-rows.ts",
      "src/stores/outbound-call-pages.ts",
    ],
    tests: [
      CONFORMANCE,
      "tests/stores/{fenced-effect*,outbound-call*,stored-not-json-fenced,key-text.property}.test.ts",
    ],
  },
  // the pause store: decisions, answers, notices and their claims (agbossjs/agboss#946), deadlines
  // and their timers (#941, #1064), reassignment
  pauses: {
    timeoutMS: 120_000,
    mutate: [
      "src/stores/postgres-paused-execution.repository.ts",
      "src/stores/postgres-paused-runs.repository.ts",
      "src/stores/postgres-pause-queries.repository.ts",
      "src/stores/paused/*.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/{pause*,paused*}.test.ts"],
  },
  // money and its limits: the cost ledger, the rate limits, the child queue
  money: {
    timeoutMS: 120_000,
    mutate: [
      "src/stores/postgres-cost-ledger.repository.ts",
      "src/stores/postgres-rate-limit.repository.ts",
      "src/stores/rate-limits/*.ts",
      "src/stores/postgres-child-execution-queue.repository.ts",
      "src/stores/child-queue/*.ts",
    ],
    tests: [
      CONFORMANCE,
      "tests/stores/{cost-ledger*,rate-limit*,child-execution-queue*}.test.ts",
      // the child queue's watch: its wake-ups, its close, the warning of a connection lost
      "tests/connection/{listener,listener-silent-death,listener-close-reopen}.test.ts",
    ],
  },
  // the child queue's watch (agbossjs/agboss#777, #789, #954; agbossjs/postgres#127): the LISTEN
  // connection of its own, its reconnect with the doubling pause, the wake-up once it listens
  // again, the liveness ping of a half-open connection, the drop of a connection at once, and
  // the close that never waits on a silent server
  "queue-watch": {
    timeoutMS: 120_000,
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
    timeoutMS: 120_000,
    mutate: [
      "src/stores/postgres-a2a-direct-message.repository.ts",
      "src/stores/a2a-direct-messages/*.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/a2a-direct-message{,-clauses}.test.ts"],
  },
  // the A2A task store (agbossjs/agboss#824): of two pods accepting one message exactly one claims
  // it, a task is saved once, the status moves by a compare-and-set on its version and never off a
  // terminal state, the reply is kept once, the retention sweep, and the page of `list`; the
  // message claim is the one the direct-message store shares (agbossjs/postgres#129 acceptance)
  "a2a-tasks": {
    timeoutMS: 120_000,
    mutate: ["src/stores/postgres-a2a-task.repository.ts", "src/stores/a2a-tasks/*.ts"],
    tests: [CONFORMANCE, "tests/stores/{a2a-task*,a2a-direct-message*}.test.ts"],
  },
  // the mesh request store (agbossjs/agboss#483): of two pods admitting one idempotency key
  // exactly one inserts it, which is what runs a trusted repeat `tools/call` once
  "mesh-requests": {
    timeoutMS: 120_000,
    mutate: ["src/stores/postgres-mesh-request.repository.ts"],
    tests: [CONFORMANCE, "tests/stores/mesh-request*.test.ts"],
  },
  // the execution record store (agbossjs/agboss#1367, agbossjs/postgres#129 acceptance): the status
  // write is a compare-and-set (`completeIfStatus`: `UPDATE ... WHERE status = $expected`) and the
  // only guard of the paused -> running mark of a resume's first phase and of a channel's decision,
  // which run on whichever instance got the answer, before and without any lease; a thread is
  // created once, the first answer of a pause is kept, and the reads recovery, replay, eval and
  // memory rely on
  "execution-records": {
    timeoutMS: 120_000,
    mutate: ["src/stores/postgres-execution-record.repository.ts", "src/stores/records/*.ts"],
    tests: [
      CONFORMANCE,
      "tests/stores/{execution-record*,minted-thread,pause-answer-text}.test.ts",
    ],
  },
  // the execution tree store (agbossjs/postgres#133, agbossjs/agboss#133): `saveIfAbsentInTree`, one `INSERT ... ON
  // CONFLICT DO NOTHING RETURNING`, is the only guard of every once-only key of a tree: the public `saveIfAbsent` of
  // user code in any execution (a child on any instance, no lease of the root) and the child-failure claim of passes
  // that overlap during a lease takeover; the keys of a tenant's root, the value as JSON, the delete of one tree
  "execution-tree": {
    timeoutMS: 120_000,
    mutate: ["src/stores/postgres-execution-tree.repository.ts"],
    tests: [CONFORMANCE, "tests/stores/{execution-tree,acceptance-text}.test.ts"],
  },
  // the checkpoint saver (agbossjs/agboss#1165): the latest checkpoint of a thread by its step,
  // and the version a branch of one checkpoint gets, which its blobs rely on
  checkpoints: {
    timeoutMS: 120_000,
    mutate: ["src/stores/postgres-checkpoint-saver.ts"],
    tests: [CONFORMANCE, "tests/stores/{checkpoint-saver,checkpoint-latest-by-step}.test.ts"],
  },
  // the schema: the migrations, their history and its check, the checkpoint tables, the live-lease
  // guard of an upgrade and a migrating start's wait for leases to lapse (agbossjs/agboss#1104)
  migrations: {
    timeoutMS: 120_000,
    mutate: ["src/migrations/*.ts"],
    tests: ["tests/migrations/*.test.ts", "tests/cli/*.test.ts"],
  },
  // every store call bounded (agbossjs/agboss#928, #1064): the command timeout, the outcome of a
  // call whose answer was lost, the transaction, the stored texts read back, the pool's clients
  // whose socket is ours to drop (#954) and the memo of a start that may be asked again
  // (agbossjs/postgres#129)
  "store-bound": {
    timeoutMS: 120_000,
    mutate: [
      "src/connection/{outcome,known-failure,timed-client,timed-pool,transaction,query,connect-timeout,pool-options,tracked-client,once,utc-session}.ts",
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
  // the driver's options and the settings they resolve to, read once at start: wiring, no money-path decision
  "src/driver.ts",
  "src/connection/driver-settings.ts",
  "src/redaction.ts",
  // No compare-and-set, claim or once-only write in these two, so no guarantee of the bar to
  // mutate: the audit log is an append-only `INSERT` read back in the order of its time and its
  // identity, and the history is a last-write-wins upsert read by period; their order and paging
  // are read by the contracts and tests/stores, and a shard would be worth it only for those reads
  "src/stores/postgres-execution-audit-log.repository.ts",
  "src/stores/audit-log/audit-event-rows.ts",
  "src/stores/postgres-execution-history.repository.ts",
  "src/stores/history/history-rows.ts",
  // the window of a paged listing (the cursor is a position the page gave): read by the history's
  // paging tests, pure
  "src/stores/listing-window.ts",
]);

/** The shard `MUTATION_SHARD` names (default `fencing`); a name of none fails. */
export function chosenShard() {
  const name = process.env.MUTATION_SHARD ?? "fencing";
  const shard = SHARDS[name];
  if (shard === undefined)
    throw new Error(`MUTATION_SHARD: "${name}" is none of ${Object.keys(SHARDS).join(", ")}`);
  return { name, ...shard };
}
