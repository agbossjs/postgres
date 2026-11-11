# Changelog

All notable changes to `@agboss/postgres`, one section per release, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. The package is versioned with
`@agboss/core` and released right after it, as one train (agbossjs/agboss `RELEASE_CHECKLIST.md`):
`@agboss/postgres@X.Y.Z` declares the peer dependency `@agboss/core` `^X.Y.Z` and is built and
tested against the `@agboss/core@X.Y.Z` on npm. Before 1.0 a minor release may break the API; the
exact public surface is `api/postgres.api.md`. Issue numbers are agbossjs/agboss's, pull requests
this repository's.

## [Unreleased] — 0.1.1 (draft: the first release)

The first published version. An application runs on PostgreSQL alone: several instances — each its
own process, no shared disk — share every store on one database.

### Changed

- **One schema per application, one setup enum, the store bundles** (#891, API review G11) —
  `PostgresConnectionSettings.schema` / the environment's `postgresSchema` put every connection in
  that schema (`DEFAULT_SCHEMA = "public"` when neither it nor the URL's `search_path` says
  otherwise; a plain lowercase identifier, else `PostgresSettingsError`), and
  `migratePostgres({ url, schema })` / `agboss-postgres migrate --schema <name>` create and migrate
  it — the migration files unchanged, so their checksums are. `schemaSetup: SchemaSetup` (the core's,
  re-exported; default `SchemaSetup.Check`) / `postgresSchemaSetup` replace `migrateOnStart` /
  `postgresMigrateOnStart`. The command and the docs read `POSTGRES_URL` (`DATABASE_URL` still
  read when it is unset, for this release only). `POSTGRES_STORES` (every store) and
  `POSTGRES_DURABLE_STORES` (without the leases, the child queue, the rate limits, the fenced
  effects and the outbound calls: beside `@agboss/redis`'s `REDIS_COORDINATION_STORES` and
  `provide(EXECUTION_ID_STORE, PostgresExecutionLeaseRepository)`). `DEFAULT_POOL_SIZE` exported.
  A start whose schema check fails ends the pool. `PostgresListener` / `PostgresListenerOptions`
  and `PostgresConnection.listen()` are no longer public (the child queue's own plumbing). The lease
  store's parameters are `held` / `identity` throughout.
- **The core's #890 (API review G8)** — the stores import what they are written with from
  `@agboss/core/stores` (the boundary rows `OutboundCallIntent`, …, and the core's store helpers
  `assertEffectName`, `replayedFromOf`, `assertLedgerEntries`, `idGeneratorNameOf`, …);
  `PostgresExecutionRecordRepository`'s methods name the core's record types (`Turn`, `NewTurn`,
  `TurnOutcome`, `NewThread`, `Summary`, `NewSummary`, `ConfigSnapshot`, `VersionScore`,
  `PauseAnswerRecord`), no local aliases; `PostgresFencedEffectRepository.runOnce` (was
  `saveResultIfAbsent`; an application injects `FencedEffects`), `deleteByResolvedAtBefore`
  (pauses) and `deleteByCreatedAtBefore` (mesh answers); `ThreadIdsExhaustedError({ generator,
tries })` (was `DuplicateThreadIdError`), `ExecutionFencedError.of(…)`; each error's static
  `code` is its literal.
- **The core's #889, the execution audit log** — `PostgresExecutionLeaseEventRepository` is
  `PostgresExecutionAuditLogRepository` (the contract `ExecutionAuditLogRepository`, its records
  `ExecutionAuditEventRecord`); the table keeps its name, `agboss_execution_lease_events`, and no
  migration runs. A record kept before #889 (pre-release builds only) keeps its copy of the log as
  `leaseEvents`; one kept from now on carries it as `auditLog`.
- **The core's #825** — every store declares one `static store = { backend: "postgres" }`, the A2A
  task store too; a fencing store checks a key's name, business key and fingerprint decision at its
  entry (`FingerprintRequiredError` before any statement); `findAllByTenantIdAndStatus({ tenantId,
status, limit, after? })` is keyset-paged on the row's identity `id`, its limit and cursor checked
  (`RangeError`); migration `0027_outbound_call_outcome_names` renames the lease log's outbound-call
  outcomes in place — `superseded` → `attempt-superseded`, `lease-superseded` → `lease-closed` with
  `supersededLease` as `closedLease` — in `agboss_execution_lease_events` and in the kept records'
  `leaseEvents`.
- **The core's #810, the mesh's facts of an A2A task** — `PostgresA2ATaskRepository` keeps a trusted
  task's `meshBodyHash` (migration `0028_a2a_task_mesh_body_hash`, a nullable column: a task saved
  before reads as untrusted) and its status's `errorDetails` (a mesh limit's facts) and `spentUsd`
  (what its run report signs); before, the two status fields were dropped on read. A status with a
  field the store does not know is now refused, never read without it.

### Added

- **The direct A2A replies, shared by the pods** (#860) — `PostgresA2ADirectMessageRepository`, the
  core's `A2ADirectMessageRepository` on migration `0030_a2a_direct_messages`
  (`agboss_a2a_direct_messages`): a skill that answers with a `Message` keeps its reply once, and a
  resend of the same `messageId` to any pod gets it — never a second run or charge. The message's
  id is claimed in the A2A task store's `agboss_a2a_messages` (a claim of no task, `task_id` `''`)
  in the same transaction as its row, so a task message and a direct message of one id are never
  both kept. Completing, taking over a lost attempt and removing a failed one are compare-and-set
  statements; the retention sweep removes the oldest rows a page at a time and frees their ids'
  claims, locking each claim before it deletes it (a resend saving under it is waited for). A reply
  is NUL-escaped `jsonb`; a row whose state and reply disagree is refused (by the table's check too).
  Declares `backend = "postgres"`: list it beside `PostgresA2ATaskRepository`, or an application
  with a direct-reply skill does not assemble (`[a2a.message-store-not-shared]`).
- **The A2A tasks, shared by the pods** (#824) — `PostgresA2ATaskRepository`, the core's
  `A2ATaskRepository` on migration `0026_a2a_tasks` (`agboss_a2a_tasks`, `agboss_a2a_messages`):
  the same `messageId` sent to two pods at once starts one execution and both answer the same task;
  `GetTask` / `ListTasks` (with its `totalSize`) read any pod's tasks; the retention sweep removes
  finished tasks with their messages. Declares `backend = "postgres"`: an application serving A2A on
  `PostgresExecutionLeaseRepository` lists it, or assembly refuses it (`[a2a.task-store-not-shared]`).
- **A run's record by its id** (#808) — `PostgresExecutionRecordRepository.findByTenantIdAndRunId`,
  the core's new record contract method (an A2A task's read repair finds its root record however
  many later turns its thread has), on migration 0025's index `(tenant_id, run_id)`. The process
  harness serves A2A v1.0; the old wire's trusted mesh dedupe test is gone with that wire.
- **A child queued by one pod wakes the others** (#777) — `PostgresChildExecutionQueueRepository`
  notifies `agboss_child_queued` (payload: its schema) in the statement that queues a child and
  implements the core's `watchQueued` with a `LISTEN` on a connection of its own per instance
  (`PostgresConnection.listen`): an idle pod claims at once instead of at its next sweep. Idle on an
  empty queue; a dropped connection reconnects and wakes once; a notification lost costs at most a
  sweep.
- **The ledger's entries are pruned** (agbossjs/agboss#771) — migration `0023_cost_entries_pruned`:
  `agboss_cost_entries.made_at` (indexed; entries of before dated `infinity`, never pruned) and
  `agboss_cost_entries_pruned`, the pruning mark. `deleteEntriesByMadeAtBefore` raises the mark and
  deletes in one statement; `saveAll` reads the mark `FOR SHARE` in its own statement and refuses an
  entry made before it that the table does not hold (`CostLedgerEntryExpiredError`, nothing added).
  Without the mark's row a save fails with `PostgresLedgerMarkMissingError`
  (`postgres.ledger-mark-missing`) and adds nothing. 0023's header also corrects 0022's, which
  described dropped ids.

- **Every store of the core on PostgreSQL** (#482, #483; #1, #3, #5, #8) — `PostgresExecutionLeaseRepository`,
  `PostgresExecutionRecordRepository`, `PostgresExecutionTreeRepository`,
  `PostgresPausedExecutionRepository`, `PostgresChildExecutionQueueRepository`,
  `PostgresCheckpointSaver` (LangGraph's `PostgresSaver` on the shared pool),
  `PostgresFencedEffectRepository` (#500, the work gets the transaction's `PoolClient`),
  `PostgresExecutionLeaseEventRepository` (#501), `PostgresCostLedgerRepository`,
  `PostgresExecutionHistoryRepository`, `PostgresRateLimitRepository`,
  `PostgresMeshRequestRepository` and `PostgresOutboundCallRepository` (#505, #508), on one `pg`
  pool per instance (`PostgresConnection`: `postgresUrl: Secret`, `postgresPoolSize`,
  `postgresMigrateOnStart`, declared environment fields, #511).
- **Migrations** (#482 AC5) — `migrations/0001` … `0021` and LangGraph's checkpoint tables under one
  advisory lock per schema: `npx agboss-postgres migrate --url <url>`, `migratePostgres({ url })`, or
  `postgresMigrateOnStart`; a second run changes nothing; `PostgresSchemaMissingError`,
  `PostgresSchemaTooNewError`, `PostgresMigrationChangedError`, `PostgresSettingsError`.
- **One backend for the fencing stores** (#526; #11) — the lease, fenced-effect and outbound-call
  stores declare `static store = { backend: "postgres" }` (#825); a mixed layout fails assembly.
- **The database's clock decides a lease's expiry** (#533; #16) — `clock_timestamp()` inside each
  statement that takes, renews, yields, reclaims, fences or closes a lease; every take and renewal
  answers `remaining`; pods whose clocks disagree agree on the instant of expiry.
- **Proved on PostgreSQL** — the core's `storeConformance` over all 13 stores, the interleaving
  explorer (#533) and the linearizability checker (#23), the fault suite (#484; #15, #27: the real
  clock, three CI shards), two-process tests of each acceptance criterion (a takeover after
  SIGKILL, `AnyInstance` children once, a pause answered on the other pod, a shared budget and rate
  limit, the history export, mesh deduplication, a payment reconciled after its pod froze).
- **The release workflow** (#691) — a pushed tag `postgres-vX.Y.Z` publishes to npm with
  provenance, only on the published core (`.agboss-version.json` `source: "registry"`,
  `node scripts/pin-framework.mjs --registry X.Y.Z`) and after CI passed on that commit; a dry run
  on every pull request that touches it.

### Guarantees and safety fixes (before any release)

- A yielded lease stays its holder's, renewed (#516; #4); a finished lease is never taken again,
  migration `0017` (#520; #9); a lease is over at its expiry for its holder too (#534; #12, #14).
- Text with a NUL character round-trips (#521; #6, migration `0013`).
- Business keys, tenant, owner and thread ids are checked as a key's text at every store entry —
  lone surrogates, controls, invisible and unassigned characters refused (#538, #547, #552, #556,
  #580, #589; #13, #17, #18, #20, #25).
- Every execution id is kept once (#591, #638, #663; #24, #29, #31: migrations `0018` – `0020`); the
  pause answer log is keyed by tree, another tree's approval kept (#676; #34, migration `0021`);
  a minted thread id is a new thread (#550, #578, #613; #22, #26).
- A child's end is heard once (#562; #19); a held job's paid action is refused once another process
  spent the tenant's day (#634; #30); every automatic undo runs once (#607; #27).
- The published package keeps its command: `bin` is `bin/agboss-postgres.js` (npm 12 dropped the
  `./bin/…` form from the tarball's manifest, #691).

### Fixed

- **A question role's pause is read back** (agbossjs/agboss#746) — the pause row check took every
  `ask` for an approval's tool call (`callId`, `tool`, `summary`), so a question asked by a flow step
  (agbossjs/agboss#659) or an agent's tool (#712) failed its execution reading its own pause. A
  question's ask (`component.kind: "question"`) is kept as written; an approval's still needs its
  tool call. The core's `pausedExecutionContract` now has the case.
- **The README's wiring compiles** (agbossjs/agboss#749) — _1. List the stores_ imported `days` from
  `@agboss/core/units`, which has none; it reads `executionRecordRetention: hours(24 * 30)`.

### Changed

- **A pause record stores its kind and names its step** (agbossjs/agboss#801) — migration
  `0024_pause_kind`: the record's `kind` (`approval` | `question`) is read as written, never told by
  its `component`, and `agent` is `step`. A row written before is rewritten once by the rule it was
  written under: a question role's component → `question`, every other pause → `approval`.

- CI installs only reviewed releases (`npm ci`, `--before` three days back, #523; #7); the gate
  fails by name unless every declared test file ran (#630; #28).
