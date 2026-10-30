# @agboss/postgres

PostgreSQL stores for [AGBoss](https://github.com/agbossjs/agboss): several application instances —
each its own process, no shared disk (pods on different Kubernetes nodes) — share execution trees on
one PostgreSQL database. A pod that dies mid-run is taken over by another from its last checkpoint;
children queued with `ChildPlacement.AnyInstance` are claimed by any instance, each exactly once; a
pause made on one instance is resumed on another.

> Status: leases, records, trees, pauses, the child queue, checkpoints and the fenced effect
> (agbossjs/agboss#482 steps 1–3 and #500). The lease events (#501), the outbound-call store (#505)
> and the two-process tests come next.

## Install

```sh
npm install @agboss/postgres
```

Peer dependency: `@agboss/core` `^0.1.1` (released together). Dependencies: `pg`,
`@langchain/langgraph-checkpoint-postgres`.

## Use

List the stores in the application's `providers`, and give the environment its database:

```ts
import { Application, Secret, secret } from "@agboss/core";
import {
  PostgresCheckpointSaver,
  PostgresChildExecutionQueueRepository,
  PostgresExecutionLeaseRepository,
  PostgresExecutionRecordRepository,
  PostgresExecutionTreeRepository,
  PostgresFencedEffectRepository,
  PostgresPausedExecutionRepository,
} from "@agboss/postgres";

export class AppEnvironment {
  postgresUrl!: Secret; // required as soon as one PostgreSQL store is listed
  postgresPoolSize?: number; // the instance's pool, default 10
  postgresMigrateOnStart?: boolean; // migrate at start, default off
}

// environments/prod.environment.ts
export const environment: AppEnvironment = { postgresUrl: secret("DATABASE_URL") };

@Application({
  name: "desk",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [DeskWorkflow],
  providers: [
    PostgresCheckpointSaver,
    PostgresChildExecutionQueueRepository,
    PostgresExecutionLeaseRepository,
    PostgresExecutionRecordRepository,
    PostgresExecutionTreeRepository,
    PostgresFencedEffectRepository, // with PostgresExecutionLeaseRepository: it reads its leases
    PostgresPausedExecutionRepository,
  ],
})
export class DeskApplication {}
```

A contract without `postgresUrl` fails the application's assembly, before anything connects:
`[environment.missing-field] PostgresExecutionLeaseRepository needs postgresUrl: Secret in
AppEnvironment (read by PostgresConnection)` — `PostgresConnection` declares the fields it reads
(`@Injectable({ environmentFields })`, agbossjs/agboss#511); the two optional ones may be absent.

Every store injects `PostgresConnection` — one `pg.Pool` per application instance, ended when the
instance stops — and answers `ping()` with `SELECT 1` (`app.checkReadiness()`). Time always comes
from the application's `Clock`, never from the database. A project subclasses a store through public
tokens only: `@Injectable({ deps: [PostgresConnection, Clock, ApplicationContext] })`, the store's
own `deps`.

A fenced effect's work gets the transaction's `PoolClient` and may `await` its statements:

```ts
const outcome = await effects.saveResultIfAbsent(fencedEffectKeyOf(executionContext, "charge"),
  async (client) => {
    await client.query("INSERT INTO charges (order_id, amount) VALUES ($1, $2)", [orderId, amount]);
    return { receipt: orderId };
  });
```

## Migrations

The schema is created by versioned SQL files (`migrations/NNNN_<name>.sql`, shipped in the package)
and LangGraph's own checkpoint tables (`PostgresSaver.setup()`), never implicitly:

```sh
npx agboss-postgres migrate --url "$DATABASE_URL"   # or DATABASE_URL alone; a Kubernetes Job
```

```ts
import { migratePostgres } from "@agboss/postgres";
const report = await migratePostgres({ url }); // { schema, applied, version, checkpointMigrations }
```

- Each migration runs in its own transaction under an advisory lock, so concurrent runs serialize;
  a second run applies nothing (`applied: []`).
- `agboss_schema_migrations (version, name, checksum, applied_at)` records what ran; an applied
  migration whose file changed fails the run (`PostgresMigrationChangedError`).
- The tables go to the first existing schema of the connection's `search_path` (`public` by default;
  `?options=-c%20search_path%3Dmy_schema` in the URL picks another).
- At start, `PostgresConnection` checks the schema: missing or older → migrated with
  `postgresMigrateOnStart: true`, else `PostgresSchemaMissingError` naming the command; newer (an
  application rolled back over a migrated database) → `PostgresSchemaTooNewError`.

| Migration                    | Tables                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_execution_leases`      | `agboss_execution_leases`                                                                                                                               |
| `0002_execution_records`     | `agboss_threads`, `agboss_execution_records`, `agboss_execution_scores`, `agboss_execution_summaries`, `agboss_config_versions`, `agboss_pause_answers` |
| `0003_execution_trees`       | `agboss_execution_tree_keys`                                                                                                                            |
| `0004_paused_executions`     | `agboss_paused_executions`, `agboss_pauses`                                                                                                             |
| `0005_child_execution_queue` | `agboss_child_execution_queue`                                                                                                                          |
| `0006_fenced_effects`        | `agboss_fenced_effect_marks`, `agboss_fenced_effect_results`                                                                                            |
| LangGraph                    | `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`                                                                         |

## Semantics per operation

All operations run at `READ COMMITTED`. Losing the connection rejects the operation; the core's
rules then apply — a failed renewal past `confirmedUntil` aborts the execution's signal and hands
the tree over, so a pod never moves a tree whose lease it could not renew.

| Store         | Operation            | How                                                                                            |
| ------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| Lease         | `acquire`            | `INSERT … ON CONFLICT DO UPDATE … WHERE released OR expires_at <= $now` → epoch + 1            |
| Lease         | `renew` / `release`  | `UPDATE … WHERE holder AND lease_epoch` (a renewal also `expires_at >= $now`); 0 rows: lost    |
| Record        | `completeIfStatus`   | `UPDATE … WHERE status = $expected`                                                            |
| Tree          | `saveIfAbsent`       | `INSERT … ON CONFLICT DO NOTHING RETURNING`                                                    |
| Child queue   | claim                | `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`                                      |
| Paused        | `Pending → …`        | `UPDATE … WHERE status = 'pending' RETURNING` (none → `NotPausedError` from the core)          |
| Fenced effect | `saveResultIfAbsent` | one transaction: lease row `FOR UPDATE`, mark upsert, key lookup, `await work(client)`, insert |
| Checkpoints   | —                    | LangGraph's `PostgresSaver` on the shared pool                                                 |

## Develop

The tests need a PostgreSQL; without `AGBOSS_POSTGRES_TEST_URL` they fail, never skip:

```sh
docker run -d --name agboss-postgres -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16
export AGBOSS_POSTGRES_TEST_URL=postgres://postgres:pw@localhost:5432/postgres
npm ci
npm run pack:framework   # @agboss/core from the SHA in .agboss-version.json
npm run install:packed   # installs that tarball (package.json unchanged)
npm run check            # format, suppressions, lint, types, tests + coverage, API report
```

Each test file works in a schema of its own (`t_<random>`), dropped after it. Every store runs the
core's published contract suite (`@agboss/core/testing/contracts`) against the real database, two
instances with two pools. Once `@agboss/core` 0.1.1 is published, `npm run install:published`
installs it from the registry instead. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0, as the core. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
