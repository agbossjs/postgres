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

### Added

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
- **Migrations** (#482 AC5) — `migrations/0001` … `0020` and LangGraph's checkpoint tables under one
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
- Every execution id is kept once (#591, #638, #663; #24, #29, #31: migrations `0018` – `0020`);
  a minted thread id is a new thread (#550, #578, #613; #22, #26).
- A child's end is heard once (#562; #19); a held job's paid action is refused once another process
  spent the tenant's day (#634; #30); every automatic undo runs once (#607; #27).
- The published package keeps its command: `bin` is `bin/agboss-postgres.js` (npm 12 dropped the
  `./bin/…` form from the tarball's manifest, #691).

### Changed

- CI installs only reviewed releases (`npm ci`, `--before` three days back, #523; #7); the gate
  fails by name unless every declared test file ran (#630; #28).
