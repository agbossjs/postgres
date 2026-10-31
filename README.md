# @agboss/postgres

PostgreSQL stores for [AGBoss](https://github.com/agbossjs/agboss): several application instances —
each its own process, no shared disk (pods on different Kubernetes nodes) — share execution trees on
one PostgreSQL database. A pod that dies mid-run is taken over by another from its last checkpoint;
children queued with `ChildPlacement.AnyInstance` are claimed by any instance, each exactly once; a
pause made on one instance is resumed on another. Budgets, provider rate limits, the execution
history and mesh request deduplication are shared too: a tenant's $10 day is $10 across every pod.
A call that leaves the system (a payment) is recorded before it is sent and reconciled, never sent
again blindly, when the pod that sent it dies or freezes mid-call.
Each of these is proven by two real `node` processes on one database (see [Tests](#tests)).

> Status: leases, records, trees, pauses, the child queue, checkpoints, the fenced effect (#500)
> and its business keys (#508), the lease log (#501), the cost ledger, the execution history, rate
> limits, mesh requests (#483) and the calls that leave the system (#505, #508): an application
> runs on PostgreSQL alone.

## Install

```sh
npm install @agboss/postgres
```

Peer dependency: `@agboss/core` `^0.1.1` (released together). Dependencies: `pg`,
`@langchain/langgraph-checkpoint-postgres`, `zod`.

## 1. List the stores

Every coordination store has a PostgreSQL implementation. List them in the application's
`providers`, in place of the in-memory defaults or the SQLite stores:

```ts
import { Application } from "@agboss/core";
import { days } from "@agboss/core/units";
import {
  PostgresCheckpointSaver,
  PostgresChildExecutionQueueRepository,
  PostgresCostLedgerRepository,
  PostgresExecutionHistoryRepository,
  PostgresExecutionLeaseEventRepository,
  PostgresExecutionLeaseRepository,
  PostgresExecutionRecordRepository,
  PostgresExecutionTreeRepository,
  PostgresFencedEffectRepository,
  PostgresMeshRequestRepository,
  PostgresOutboundCallRepository,
  PostgresPausedExecutionRepository,
  PostgresRateLimitRepository,
} from "@agboss/postgres";
import { AppEnvironment } from "./environments/app.environment.js";

@Application({
  name: "desk",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [DeskWorkflow],
  executionRecordRetention: days(30), // keeps the history `agboss records export` reads
  providers: [
    PostgresCheckpointSaver, // LangGraph's PostgresSaver on the shared pool
    PostgresChildExecutionQueueRepository, // ChildPlacement.AnyInstance children
    PostgresCostLedgerRepository, // budgets: every pod's spend in one counter
    PostgresExecutionHistoryRepository, // agboss records export, from any pod
    PostgresExecutionLeaseEventRepository, // the lease log: app.leaseEventsOf
    PostgresExecutionLeaseRepository, // who moves a tree, fenced by epoch
    PostgresExecutionRecordRepository, // threads, records, scores, summaries
    PostgresExecutionTreeRepository, // a tree's keys (saveIfAbsent)
    PostgresFencedEffectRepository, // with PostgresExecutionLeaseRepository: it reads its leases
    PostgresMeshRequestRepository, // a mesh request retried on another pod runs once
    PostgresOutboundCallRepository, // OutboundCalls: intents, reconciled on any pod
    PostgresPausedExecutionRepository, // pauses, answered on any instance
    PostgresRateLimitRepository, // maxConcurrentCalls, per-minute windows, 429 pauses, breakers
  ],
})
export class DeskApplication {}
```

| Store                                   | Core contract                        | Tables                                                              |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| `PostgresExecutionLeaseRepository`      | `ExecutionLeaseRepository`           | `agboss_execution_leases`                                           |
| `PostgresExecutionRecordRepository`     | `ExecutionRecordRepository`          | `agboss_threads`, `agboss_execution_records`, … (`0002`)            |
| `PostgresExecutionTreeRepository`       | `ExecutionTreeRepository`            | `agboss_execution_tree_keys`                                        |
| `PostgresPausedExecutionRepository`     | `PausedExecutionRepository`          | `agboss_paused_executions`, `agboss_pauses`                         |
| `PostgresChildExecutionQueueRepository` | `ChildExecutionQueueRepository`      | `agboss_child_execution_queue`                                      |
| `PostgresCheckpointSaver`               | LangGraph `BaseCheckpointSaver`      | `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`              |
| `PostgresFencedEffectRepository`        | `FencedEffectRepository<PoolClient>` | `agboss_fenced_effect_marks`, `…_results`, `…_business_results`     |
| `PostgresOutboundCallRepository`        | `OutboundCallRepository`             | `agboss_outbound_calls` (and the leases' `superseded`, `0014`)      |
| `PostgresExecutionLeaseEventRepository` | `ExecutionLeaseEventRepository`      | `agboss_execution_lease_events`                                     |
| `PostgresCostLedgerRepository`          | `CostLedgerRepository`               | `agboss_cost_counters`, `agboss_cost_max_spend`                     |
| `PostgresExecutionHistoryRepository`    | `ExecutionHistoryRepository`         | `agboss_execution_history`                                          |
| `PostgresRateLimitRepository`           | `RateLimitRepository`                | `agboss_rate_limit_keys`, `…_slots`, `…_window_buckets`, `…_pauses` |
| `PostgresMeshRequestRepository`         | `MeshRequestRepository`              | `agboss_mesh_requests`                                              |

With all of them listed, nothing of the application is per pod: budgets sum every pod's spend, a
provider's limits hold across pods, `agboss records export` on any pod lists every pod's
executions, and a mesh request retried against another pod is answered from the first run.

Every store injects `PostgresConnection` — one `pg.Pool` per application instance, ended when the
instance stops — and answers `ping()` with `SELECT 1` (`app.checkReadiness()`). **The database's
clock decides when a lease ends** (agbossjs/agboss#533): every statement that takes, renews, yields,
reclaims, fences a write under or closes a lease reads `clock_timestamp()` inside itself, so pods
whose wall clocks disagree — by seconds or by minutes — agree on the instant of expiry; each take and
renewal answers the time the lease has left, which the holder counts down on its monotonic clock
less a 1 s margin. Under `testWith` and the contract suites the test's clock is injected instead
(`StoreClock`), so time can be moved. Other times (records, retention) are the application's
`Clock`'s. A project subclasses a store through public tokens only: `@Injectable({ deps:
[PostgresConnection, StoreClock, ApplicationContext] })`, the store's own `deps`.

**One backend.** `PostgresExecutionLeaseRepository`, `PostgresFencedEffectRepository` and
`PostgresOutboundCallRepository` declare `static backend = "postgres"` (agbossjs/agboss#526): a
fenced effect or an outbound call checks its lease in its own transaction, so assembly requires its
store and the application's lease store to declare the same backend. List the three together; a
mixed layout — PostgreSQL leases with in-memory or SQLite fenced effects or outbound calls, or
PostgreSQL fencing stores with any other lease store — fails with
`[application.store-backend-mismatch]`, naming both stores and both backends. A subclass inherits
`"postgres"`; one on another database declares `"postgres:<database>"` on all three. Rate limits,
the child queue, the lease log and the other stores are not constrained. To write a store of your
own, on another database, see the Wiki's
[Your own store](https://github.com/agbossjs/agboss/wiki/Your-own-store).

A fenced effect's work gets the transaction's `PoolClient` and may `await` its statements:

```ts
const outcome = await effects.saveResultIfAbsent(
  fencedEffectKeyOf(executionContext, "charge"),
  async (client) => {
    await client.query("INSERT INTO charges (order_id, amount) VALUES ($1, $2)", [orderId, amount]);
    return { receipt: orderId };
  },
);
```

With a business key (#508) the effect is one per tenant, name and key — whatever execution, visit or
thread makes it — instead of one per step:
`fencedEffectKeyOf(executionContext, "charge", { businessKey: "order:42", fingerprint: { amount } })`.
A second execution's call replays the first one's result (`replayedFrom` names its step); the same
key with another fingerprint is `IdempotencyKeyConflictError`, nothing run.

### Calls that leave the system

`OutboundCalls.send` (#505) records an intent in `agboss_outbound_calls` before the request goes out
and settles it after; an intent left pending — the pod died or froze mid-call — is reconciled with
the other system (`reconcile`) by whichever pod runs the step next, never sent again blindly:

```ts
const key = fencedEffectKeyOf(executionContext, "charge", { businessKey: `order:${orderId}` });
const { result } = await outboundCalls.send(key, {
  target: "payments",
  operation: "charge",
  request: { orderId, amount },
  send: (call) => gateway.charge({ orderId, amount }, call.idempotencyKey, call.signal),
  reconcile: async (lookup) => {
    const found = await gateway.find(lookup.idempotencyKey);
    return found === undefined
      ? OutboundCallReconciliation.notSent()
      : OutboundCallReconciliation.completed(found);
  },
});
```

List `PostgresOutboundCallRepository` with `PostgresExecutionLeaseRepository`: it reads its leases.
`PostgresConnection` need not be listed — the container creates it for the stores that use it
(agbossjs/agboss#526); list it only when a component of yours injects it. Under a business key, a
pending intent found under another execution's lease asks `leaseStateOf`: a live lease is a call in
flight (`OutboundCallInFlightError`); an expired one is closed by that check, in
the same transaction — released and marked `superseded`, so its holder can neither renew it nor
write under it again, and the next take of its tree names it (`takenOverFrom`) — and the call is
reconciled (`lease-superseded` in the lease log, with the closed lease).

The lease log keeps who took a tree over and from whom — `app.leaseEventsOf({ tenantId,
rootExecutionId })` reads it on any instance, oldest first:

```ts
const [takeover] = await app.leaseEventsOf({ tenantId: "default", rootExecutionId });
// { kind: "takeover", reason: "recovered", holderInstanceId: "<B>",
//   previousHolderInstanceId: "<A>", previousToken: 1, token: 2, … }
```

## 2. The environment

`PostgresConnection` declares the fields it reads, so the core checks them at assembly:

| Field                    | Type      | Default | What                                                    |
| ------------------------ | --------- | ------- | ------------------------------------------------------- |
| `postgresUrl`            | `Secret`  | —       | the database: `postgres://user:password@host:5432/db`   |
| `postgresPoolSize`       | `number`  | `10`    | the most connections this instance's pool opens         |
| `postgresMigrateOnStart` | `boolean` | `false` | migrate a database that lacks this package's migrations |

```ts
// environments/app.environment.ts — the contract
import type { Secret } from "@agboss/core";

export class AppEnvironment {
  postgresUrl!: Secret; // required as soon as one PostgreSQL store is listed
  postgresPoolSize?: number;
  postgresMigrateOnStart?: boolean;
}
```

```ts
// environments/prod.environment.ts — the values
import { secret } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  postgresUrl: secret("DATABASE_URL"),
  postgresPoolSize: 20,
};
```

A contract without `postgresUrl` fails the application's assembly, before anything connects:
`[environment.missing-field] PostgresExecutionLeaseRepository needs postgresUrl: Secret in
AppEnvironment (read by PostgresConnection)`. A value of the wrong kind (a plain string for the URL,
a pool size of 0) fails the start with `PostgresSettingsError`, naming the field, never the URL.

The tables go to the first existing schema of the connection's `search_path` (`public` by default);
`?options=-c%20search_path%3Dmy_schema` in the URL picks another.

## 3. Migrations

The schema is created by versioned SQL files (`migrations/NNNN_<name>.sql`, shipped in the package)
and LangGraph's own checkpoint tables (`PostgresSaver.setup()`), never implicitly. Run them in one
of two ways.

**A command** — before the new version of the application starts:

```sh
npx agboss-postgres migrate --url "$DATABASE_URL"   # or DATABASE_URL alone
```

```text
applied 0001_execution_leases (public)
…
applied 0017_execution_lease_finished (public)
applied 6 LangGraph checkpoint migration(s)
```

A second run prints `nothing to apply: public is at migration 17`. Exit codes: `0` done, `1` the
migration failed (the reason on stderr), `2` a usage error.

In Kubernetes, the command is a Job run before the Deployment rolls out (a Helm `pre-upgrade` hook,
an Argo CD `PreSync` hook, or a step of the pipeline):

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: desk-migrate
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example.com/desk:1.4.0 # the application's own image: same package version
          command: ["npx", "agboss-postgres", "migrate"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: desk-postgres, key: url }
```

**Or in code**, from a script of your own:

```ts
import { migratePostgres } from "@agboss/postgres";

const report = await migratePostgres({ url, signal });
// { schema: "public", applied: [{ version: 12, name: "mesh_requests" }], version: 12, checkpointMigrations: 0 }
```

**The start flag.** At `onInit`, `PostgresConnection` compares the database with the package:

| The database is…   | `postgresMigrateOnStart: true` | otherwise                                                     |
| ------------------ | ------------------------------ | ------------------------------------------------------------- |
| at this version    | starts                         | starts                                                        |
| missing or older   | migrates it, then starts       | `PostgresSchemaMissingError`, naming the command and the flag |
| newer (a rollback) | `PostgresSchemaTooNewError`    | `PostgresSchemaTooNewError`: migrations are never rolled back |

The flag suits a single instance or a development database; with several pods, prefer the Job, so
a pod never waits on another's migration at start (both are safe: they serialize on the lock).

- Each migration runs in its own transaction under an advisory lock (per schema), so concurrent
  runs serialize; a second run applies nothing (`applied: []`) and leaves the schema unchanged.
- `agboss_schema_migrations (version, name, checksum, applied_at)` records what ran; an applied
  migration whose file changed fails the run (`PostgresMigrationChangedError`).

| Migration                          | Tables                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_execution_leases`            | `agboss_execution_leases`                                                                                                                               |
| `0002_execution_records`           | `agboss_threads`, `agboss_execution_records`, `agboss_execution_scores`, `agboss_execution_summaries`, `agboss_config_versions`, `agboss_pause_answers` |
| `0003_execution_trees`             | `agboss_execution_tree_keys`                                                                                                                            |
| `0004_paused_executions`           | `agboss_paused_executions`, `agboss_pauses`                                                                                                             |
| `0005_child_execution_queue`       | `agboss_child_execution_queue`                                                                                                                          |
| `0006_fenced_effects`              | `agboss_fenced_effect_marks`, `agboss_fenced_effect_results`                                                                                            |
| `0007_execution_lease_events`      | `agboss_execution_lease_events`                                                                                                                         |
| `0008_execution_lease_yield`       | `agboss_execution_leases.yielded` (agbossjs/agboss#516)                                                                                                 |
| `0009_cost_ledger`                 | `agboss_cost_counters`, `agboss_cost_max_spend`                                                                                                         |
| `0010_execution_history`           | `agboss_execution_history`                                                                                                                              |
| `0011_rate_limits`                 | `agboss_rate_limit_keys`, `agboss_rate_limit_slots`, `agboss_rate_limit_window_buckets`, `agboss_rate_limit_pauses`                                     |
| `0012_mesh_requests`               | `agboss_mesh_requests`                                                                                                                                  |
| `0013_nul_escape`                  | none: doubles U+E000 in the columns the stores now escape (agbossjs/agboss#521)                                                                         |
| `0014_execution_lease_superseded`  | `agboss_execution_leases.superseded`: a lease an outbound call's check closed (agbossjs/agboss#508)                                                     |
| `0015_fenced_effect_business_keys` | `agboss_fenced_effect_business_results` (agbossjs/agboss#508)                                                                                           |
| `0016_outbound_calls`              | `agboss_outbound_calls` (agbossjs/agboss#505, #508)                                                                                                     |
| `0017_execution_lease_finished`    | `agboss_execution_leases.finished`: a lease its holder finished, never taken again (agbossjs/agboss#520)                                                |
| LangGraph                          | `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`                                                                         |

## Text with a NUL character

PostgreSQL keeps no NUL character (U+0000): `text` refuses it and `jsonb` refuses the escape
`\u0000`. A model's or a tool's answer may hold one, and a store gives back what the framework hands
it (agbossjs/agboss#521, the NUL case of each contract suite). So every framework string kept in
`jsonb` (records' route and steps, tree values, pauses, lease events, history, mesh answers) or as
free text (a record's task, answer and stop reason, a summary, an outbound call's record and the
idempotency key and attempt owner it is matched by) is escaped on the way in and back on
the way out — U+0000 → U+E000 `0`, U+E000 → U+E000 U+E000 (`src/stores/nul-escape.ts`); nothing else
changes, so `jsonb`'s operators keep working. Columns that keep JSON as `text` (a paused run, the
pause log, the child queue, fenced-effect results) hold `\u0000` as an escape already. Checkpoints
are LangGraph's `bytea` blobs.

## Semantics per operation

All operations run at `READ COMMITTED`. Losing the connection rejects the operation; the core's
rules then apply — a failed renewal past `confirmedUntil` aborts the execution's signal and hands
the tree over, so a pod never moves a tree whose lease it could not renew.

| Store         | Operation            | How                                                                                                                                   |
| ------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Lease         | `acquire`            | `INSERT … ON CONFLICT DO UPDATE … WHERE NOT finished AND (released OR expires_at <= $now)` → epoch + 1, `takenOverFrom` if expired    |
| Lease         | `finish`             | `UPDATE … SET released, finished WHERE holder AND lease_epoch`: refused by every later `acquire`; a later `release` keeps it finished |
| Lease         | `renew` / `release`  | `UPDATE … WHERE holder AND lease_epoch` (a renewal also `expires_at > $now`, #534); 0 rows: lost                                      |
| Lease         | `yield` / `reclaim`  | `UPDATE … WHERE holder AND lease_epoch AND expires_at > $now`: `yielded = true` / epoch + 1; 0 rows: lost                             |
| Record        | `completeIfStatus`   | `UPDATE … WHERE status = $expected`                                                                                                   |
| Tree          | `saveIfAbsent`       | `INSERT … ON CONFLICT DO NOTHING RETURNING`                                                                                           |
| Child queue   | claim                | `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`                                                                             |
| Paused        | `Pending → …`        | `UPDATE … WHERE status = 'pending' RETURNING` (none → `NotPausedError` from the core)                                                 |
| Fenced effect | `saveResultIfAbsent` | one transaction: lease row `FOR UPDATE`, mark upsert, key lookup, `await work(client)`, insert                                        |
| Fenced effect | business key         | the same, the key's identity serialized by `pg_advisory_xact_lock` first (no lease row covers two trees)                              |
| Outbound call | `saveIfAbsent`       | one transaction: lease row `FOR UPDATE`, mark upsert, `INSERT … ON CONFLICT DO NOTHING` (unique by step / key)                        |
| Outbound call | `mark*`              | the same checks, then one `UPDATE … WHERE status AND attempt AND attempt_owner` as read: a compare-and-set                            |
| Outbound call | `leaseStateOf`       | one transaction: lease row `FOR UPDATE`; held → Live, expired at the token → closed (`superseded`), else Ended                        |
| Lease events  | `save`               | append-only `INSERT`; read `ORDER BY occurred_at, id` (one moment: the order saved)                                                   |
| Cost ledger   | `saveAll`            | one `INSERT … ON CONFLICT DO UPDATE SET spent_usd = spent_usd + $cost` of every counter, in key order                                 |
| Cost ledger   | `findSpentByCounter` | `SELECT` of the counter's row; no other locking (the core accepts a small overrun on a race, nothing reserved)                        |
| History       | `save`               | upsert of the root's row (`jsonb` record); reads by tenant, id, thread, period (`LIMIT`/`OFFSET`), oldest first                       |
| Rate limit    | `acquire`            | one transaction: the key's row `FOR UPDATE`, then sweep expired + `INSERT … WHERE count(valid) < max`                                 |
| Rate limit    | `renew` / `release`  | `UPDATE … WHERE slot_id AND expires_at > $now` (0 rows: expired) / `DELETE`                                                           |
| Rate limit    | `addToWindow`        | the key's row `FOR UPDATE`, old buckets forgotten, sum, add to this millisecond's bucket if within the limit                          |
| Rate limit    | `pauseUntil`         | upsert keeping `GREATEST(paused_until, $until)`: a 429 pause or an open breaker, seen by every pod                                    |
| Mesh request  | `saveIfAbsent`       | `INSERT … ON CONFLICT DO NOTHING` by (tenant, peer, idempotency key); `deleteCreatedBefore` for the sweep                             |
| Checkpoints   | —                    | LangGraph's `PostgresSaver` on the shared pool                                                                                        |

## Tests

The tests need a PostgreSQL; without `AGBOSS_POSTGRES_TEST_URL` they fail, never skip:

```sh
docker run -d --name agboss-postgres -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16
export AGBOSS_POSTGRES_TEST_URL=postgres://postgres:pw@localhost:5432/postgres
npm ci
npm run pack:framework   # @agboss/core and @agboss/cli from the SHA in .agboss-version.json
npm run install:packed   # installs those tarballs (package.json unchanged)
npm test                 # every test, the process tests included (~2 min: some wait out a lease)
npm run check            # format, suppressions, flow types, lint, types, tests + coverage, API report
npm run test:faults      # the fault suite (below): ~20 min on the real clock; AGBOSS_FAULT_TIME_SCALE=5 for ~5
```

Each test file works in a schema of its own (`t_<random>`), dropped after it.

- **Contract suites** (`tests/contracts/store-conformance.test.ts`) — one `storeConformance` of
  `@agboss/core/testing/contracts` (agbossjs/agboss#526) runs every store's published suite
  against the real database, two instances with two pools, and the store set's cases (the three
  fencing stores declare one backend). Nothing is left out.
- **Backends at assembly** (`tests/processes/store-backends.test.ts`) — mixed layouts fail with
  `[application.store-backend-mismatch]`; the all-PostgreSQL layout assembles.
- **Two real processes** (`tests/processes/`) — each instance is a separate `node` process with its
  own pool, running the application of `tests/fixtures/` on the test's schema, driven by JSON lines
  on stdin and stdout. The processes share nothing but the database; a step that must stay busy
  waits at a gate in its own process's memory, opened by the test.
  - `takeover.test.ts` (AC1): A is killed with SIGKILL mid-step; B, started afterwards, takes the
    tree over and finishes it — the finished step is not run again — and `app.leaseEventsOf` on B
    shows the takeover with A as the previous holder. It uses the real `Clock` and the core's lease,
    30 s and not a setting, so it waits for B's second recovery sweep: about 30 s.
  - `child-queue.test.ts` (AC2): five `AnyInstance` children, one step slot per instance: A and B
    each hold one at the same time, and every child runs once (a few seconds).
  - `finished-child.test.ts` (agbossjs/agboss#520 AC1): A's worker asks for the lease of a child B
    runs; the ask is held in A's lease store by the core's published store hold points
    (`withHoldPoints(PostgresExecutionLeaseRepository)`, `@agboss/core/testing/faults`), A is frozen (SIGSTOP), B answers the child and finishes
    its lease, A is thawed (SIGCONT) and its ask goes on: A gets no lease, the child's row stays B's,
    finished, and the lease log has no takeover of it (a few seconds).
  - `pause-resume.test.ts` (AC3): a pause made on A is answered on B; the tool runs on B, once
    (a few seconds).
  - `shared-budget.test.ts` (#483 AC1): a $5 call on A and one on B spend the tenant's $10 day;
    the next execution, on either process, is refused with `BudgetExceededError` before any call.
  - `shared-rate-limit.test.ts` (#483 AC2): four executions on A and B against a provider with
    `maxConcurrentCalls: 1`; the provider's calls, timed on the `Clock`, never overlap.
  - `history-export.test.ts` (#483 AC3): `agboss records export --all-tenants`, run with B's
    environment, lists the executions run on A and on B.
  - `mesh-dedup.test.ts` (#483 AC4): a signed A2A request sent to A, then the same one to B, runs
    once; B answers with A's answer.
  - `outbound-charge.test.ts` (AC1 + #505, #508): the payment gateway is two tables beside the
    stores. A is frozen (SIGSTOP) mid-charge — charged, the answer not stored; B takes the tree
    over and reconciles instead of charging. Then the same order's business key in a second tree:
    B closes A's expired lease (`lease-superseded`), reconciles, and its sweep finishes A's tree from
    the stored charge, the takeover naming A. Thawed, A's late answer is fenced each time: one
    request ever reaches the gateway. About 30 s and 50 s (the lease and the sweep, 30 s each).
- **The fault suite** (`tests/faults/`, `npm run test:faults`, CI's `faults` job) — the core's
  `faultSuite` (agbossjs/agboss#484) on PostgreSQL: its fixture application in real `node` pods
  on one database, each pod through a TCP proxy of its own. Its scenarios kill (SIGKILL), stop
  (SIGTERM), freeze (SIGSTOP / SIGCONT) and cut pods off the database, and check after each that
  every tree had one owner at a time, every child and every charge happened once, no hand-over
  undid anything and every tree finished. `tests/faults/postgres.fault-stores.ts` is the store set
  every pod lists. Pull requests run every pod's clock 5 times faster; pushes to main and the
  nightly run use the real clock. What it proves:
  [Guarantees across processes](https://github.com/agbossjs/agboss/wiki/Guarantees-across-processes).
- **Migrations** (`tests/migrations/`) — AC5: a second run changes nothing (a schema dump compared),
  concurrent runs serialize, a changed file fails, too new / too old fail at start; leases written
  before `0014` keep working (taken, renewed, closed as expired), and those before `0017` are not
  finished (taken, renewed, reclaimed and finished as before).
- **Races** (`tests/stores/outbound-call.test.ts`, `fenced-effect.test.ts`,
  `execution-lease-finish.test.ts`) — beyond the contract's two instances: six connections racing on
  one business key, one intent and one expired lease, and a lease's finish and release against four
  acquires, fifteen rounds each — and a check-then-write port beside them that the same race
  catches. `execution-lease-finish-order.test.ts` runs the finish, the release and an acquire in
  each order, queued behind a row lock the test holds.

`npm run check:types` runs the pinned CLI's `agboss check` on the fixtures' application, which
writes `.agboss/types.d.ts` (never committed) — the flow types `tsconfig.processes.json` compiles
the fixtures against. Once `@agboss/core` 0.1.1 is published, `npm run install:published` installs
it (and the CLI) from the registry instead. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0, as the core. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
