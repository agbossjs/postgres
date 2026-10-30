# @agboss/postgres

PostgreSQL stores for [AGBoss](https://github.com/agbossjs/agboss): several application instances —
each its own process, no shared disk (pods on different Kubernetes nodes) — share execution trees on
one PostgreSQL database. A pod that dies mid-run is taken over by another from its last checkpoint;
children queued with `ChildPlacement.AnyInstance` are claimed by any instance, each exactly once; a
pause made on one instance is resumed on another. Each of these is proven by two real `node`
processes on one database (see [Tests](#tests)).

> Status: leases, records, trees, pauses, the child queue, checkpoints, the fenced effect (#500) and
> the lease log (#501). The outbound-call store (#505) comes next.

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
import {
  PostgresCheckpointSaver,
  PostgresChildExecutionQueueRepository,
  PostgresExecutionLeaseEventRepository,
  PostgresExecutionLeaseRepository,
  PostgresExecutionRecordRepository,
  PostgresExecutionTreeRepository,
  PostgresFencedEffectRepository,
  PostgresPausedExecutionRepository,
} from "@agboss/postgres";
import { AppEnvironment } from "./environments/app.environment.js";

@Application({
  name: "desk",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [DeskWorkflow],
  providers: [
    PostgresCheckpointSaver, // LangGraph's PostgresSaver on the shared pool
    PostgresChildExecutionQueueRepository, // ChildPlacement.AnyInstance children
    PostgresExecutionLeaseEventRepository, // the lease log: app.leaseEventsOf
    PostgresExecutionLeaseRepository, // who moves a tree, fenced by epoch
    PostgresExecutionRecordRepository, // threads, records, scores, summaries
    PostgresExecutionTreeRepository, // a tree's keys (saveIfAbsent)
    PostgresFencedEffectRepository, // with PostgresExecutionLeaseRepository: it reads its leases
    PostgresPausedExecutionRepository, // pauses, answered on any instance
  ],
})
export class DeskApplication {}
```

| Store                                   | Core contract                        | Tables                                                       |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `PostgresExecutionLeaseRepository`      | `ExecutionLeaseRepository`           | `agboss_execution_leases`                                    |
| `PostgresExecutionRecordRepository`     | `ExecutionRecordRepository`          | `agboss_threads`, `agboss_execution_records`, … (`0002`)     |
| `PostgresExecutionTreeRepository`       | `ExecutionTreeRepository`            | `agboss_execution_tree_keys`                                 |
| `PostgresPausedExecutionRepository`     | `PausedExecutionRepository`          | `agboss_paused_executions`, `agboss_pauses`                  |
| `PostgresChildExecutionQueueRepository` | `ChildExecutionQueueRepository`      | `agboss_child_execution_queue`                               |
| `PostgresCheckpointSaver`               | LangGraph `BaseCheckpointSaver`      | `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`       |
| `PostgresFencedEffectRepository`        | `FencedEffectRepository<PoolClient>` | `agboss_fenced_effect_marks`, `agboss_fenced_effect_results` |
| `PostgresExecutionLeaseEventRepository` | `ExecutionLeaseEventRepository`      | `agboss_execution_lease_events`                              |

The cost ledger, rate limits, history and mesh requests are not in this package yet (the next
sub-issue of agbossjs/agboss#469): until then each instance counts budgets on its own, which the
application's start warns about (`application.in-memory-cost-ledger`).

Every store injects `PostgresConnection` — one `pg.Pool` per application instance, ended when the
instance stops — and answers `ping()` with `SELECT 1` (`app.checkReadiness()`). Time always comes
from the application's `Clock`, never from the database. A project subclasses a store through public
tokens only: `@Injectable({ deps: [PostgresConnection, Clock, ApplicationContext] })`, the store's
own `deps`.

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
applied 0007_execution_lease_events (public)
applied 6 LangGraph checkpoint migration(s)
```

A second run prints `nothing to apply: public is at migration 7`. Exit codes: `0` done, `1` the
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
// { schema: "public", applied: [{ version: 7, name: "execution_lease_events" }], version: 7, checkpointMigrations: 0 }
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

| Migration                     | Tables                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_execution_leases`       | `agboss_execution_leases`                                                                                                                               |
| `0002_execution_records`      | `agboss_threads`, `agboss_execution_records`, `agboss_execution_scores`, `agboss_execution_summaries`, `agboss_config_versions`, `agboss_pause_answers` |
| `0003_execution_trees`        | `agboss_execution_tree_keys`                                                                                                                            |
| `0004_paused_executions`      | `agboss_paused_executions`, `agboss_pauses`                                                                                                             |
| `0005_child_execution_queue`  | `agboss_child_execution_queue`                                                                                                                          |
| `0006_fenced_effects`         | `agboss_fenced_effect_marks`, `agboss_fenced_effect_results`                                                                                            |
| `0007_execution_lease_events` | `agboss_execution_lease_events`                                                                                                                         |
| LangGraph                     | `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`                                                                         |

## Semantics per operation

All operations run at `READ COMMITTED`. Losing the connection rejects the operation; the core's
rules then apply — a failed renewal past `confirmedUntil` aborts the execution's signal and hands
the tree over, so a pod never moves a tree whose lease it could not renew.

| Store         | Operation            | How                                                                                                             |
| ------------- | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| Lease         | `acquire`            | `INSERT … ON CONFLICT DO UPDATE … WHERE released OR expires_at <= $now` → epoch + 1, `takenOverFrom` if expired |
| Lease         | `renew` / `release`  | `UPDATE … WHERE holder AND lease_epoch` (a renewal also `expires_at >= $now`); 0 rows: lost                     |
| Record        | `completeIfStatus`   | `UPDATE … WHERE status = $expected`                                                                             |
| Tree          | `saveIfAbsent`       | `INSERT … ON CONFLICT DO NOTHING RETURNING`                                                                     |
| Child queue   | claim                | `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`                                                       |
| Paused        | `Pending → …`        | `UPDATE … WHERE status = 'pending' RETURNING` (none → `NotPausedError` from the core)                           |
| Fenced effect | `saveResultIfAbsent` | one transaction: lease row `FOR UPDATE`, mark upsert, key lookup, `await work(client)`, insert                  |
| Lease events  | `save`               | append-only `INSERT`; read `ORDER BY occurred_at, id` (one moment: the order saved)                             |
| Checkpoints   | —                    | LangGraph's `PostgresSaver` on the shared pool                                                                  |

## Tests

The tests need a PostgreSQL; without `AGBOSS_POSTGRES_TEST_URL` they fail, never skip:

```sh
docker run -d --name agboss-postgres -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16
export AGBOSS_POSTGRES_TEST_URL=postgres://postgres:pw@localhost:5432/postgres
npm ci
npm run pack:framework   # @agboss/core and @agboss/cli from the SHA in .agboss-version.json
npm run install:packed   # installs those tarballs (package.json unchanged)
npm test                 # every test, the process tests included (~35 s: one waits out a lease)
npm run check            # format, suppressions, flow types, lint, types, tests + coverage, API report
```

Each test file works in a schema of its own (`t_<random>`), dropped after it.

- **Contract suites** (`tests/contracts/`) — every store runs the core's published suite
  (`@agboss/core/testing/contracts`) against the real database, two instances with two pools.
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
  - `pause-resume.test.ts` (AC3): a pause made on A is answered on B; the tool runs on B, once
    (a few seconds).
- **Migrations** (`tests/migrations/`) — AC5: a second run changes nothing (a schema dump compared),
  concurrent runs serialize, a changed file fails, too new / too old fail at start.

`npm run check:types` runs the pinned CLI's `agboss check` on the fixtures' application, which
writes `.agboss/types.d.ts` (never committed) — the flow types `tsconfig.processes.json` compiles
the fixtures against. Once `@agboss/core` 0.1.1 is published, `npm run install:published` installs
it (and the CLI) from the registry instead. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0, as the core. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
