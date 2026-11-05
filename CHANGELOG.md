# Changelog

All notable changes to `@agboss/postgres`, one section per release, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. The package is versioned with
`@agboss/core` and released right after it, as one train (agbossjs/agboss `RELEASE_CHECKLIST.md`):
`@agboss/postgres@X.Y.Z` declares the peer dependency `@agboss/core` `^X.Y.Z` and is built and
tested against the `@agboss/core@X.Y.Z` on npm. Before 1.0 a minor release may break the API; the
exact public surface is `api/postgres.api.md`. Issue numbers are agbossjs/agboss's, pull requests
this repository's.

## [0.1.1] — 2026-11-05

The first published version. An application runs on PostgreSQL alone: several instances — each its
own process, no shared disk — share every store on one database.

### Added

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
  stores declare `static backend = "postgres"`; a mixed layout fails assembly.
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

- CI installs only reviewed releases (`npm ci`, `--before` three days back, #523; #7); the gate
  fails by name unless every declared test file ran (#630; #28).
