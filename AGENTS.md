# AGENTS.md — @agboss/postgres

AGBoss's stores on PostgreSQL (agbossjs/agboss#482, #483): several application instances, each its
own process with no shared disk, share execution trees, budgets, history, rate limits, mesh
requests and the calls that leave the system (agbossjs/agboss#505, #508) on one database. The package implements the core's infrastructure contracts; it never
changes them.

## Stack

TypeScript strict, ESM, Node 22+ · `pg` (one pool per application instance) · LangGraph's
`PostgresSaver` for checkpoints · zod for every row read back · Vitest + v8 coverage against a real
PostgreSQL (`AGBOSS_POSTGRES_TEST_URL`) · api-extractor (`api/postgres.api.md`).

## Commands

- `npm run pack:framework && npm run install:packed` — `@agboss/core` and `@agboss/cli` at the SHA
  pinned in `.agboss-version.json` (pin the current agboss `main` when a store needs a newer core).
- `npm run check` (`make check`) — `npm run check:static`, then the tests with coverage.
- `npm run check:static` (`make static`; run it before queueing for a gate, agbossjs/agboss#1213) —
  the root allowlist (`check:root`, `.root-allowlist`), unused files and dependencies
  (`check:knip`, `knip.jsonc`), the docs (`check:docs`: every README ts block compiles against the
  build — `file=`, `no-check: <reason>`, `<!-- snippet-context -->` as the core's — and every
  `npm run …` / `scripts/…` they name exists), and the stages below but the tests.
- `MUTATION_SHARD=<shard> npm run test:mutation` (`make mutation SHARD=<shard>`) — Stryker on one
  shard of `scripts/mutation-shards.mjs` (`fencing`, `effects-and-calls`, `pauses`, `money`,
  `migrations`, `store-bound`) against `AGBOSS_POSTGRES_TEST_URL`; below 100 % killed or justified it
  fails (agbossjs/agboss#1213). CI runs each shard incrementally, cold when the mutation setup
  changes, `mutation-nightly.yml` every night cold; run every shard a change touches locally first.
- What `npm run check` runs: format, suppressions (budget 0), flow types (`check:types`: the CLI's
  `agboss check` on `tests/fixtures/`, writes the uncommitted `.agboss/types.d.ts`), lint, types,
  tests with coverage, API report.
- `npx agboss-postgres migrate --url <url> [--schema <name>]` — the migrations (after `npm run build`).

## Architecture

- `src/connection/` — `PostgresConnection` (DI token, `deps: [DATABASE_SETTINGS]`, or
  `new PostgresConnection({ url })` in a script/test), its settings the application's `@DatabaseStorage`
  (`PostgresDriver({ url, schema, poolSize, schemaSetup, timeouts })`) and nothing else — the environment is no
  source of the connection (agbossjs/agboss#1324) —, the connect bound (agbossjs/agboss#989: the URL's `connect_timeout`, else
  `DEFAULT_CONNECT_TIMEOUT`, 10 s), the query helpers (rows
  as `unknown`, validated by each store) and the transaction helper (a pool of one never deadlocks).
- `src/migrations/` — `migrations/NNNN_<name>.sql` read and checksummed, the history table, the
  advisory-locked run (`migratePostgres`), the start check (`PostgresSchemaMissingError` /
  `PostgresSchemaTooNewError`). A schema change is always a new file; an applied file never changes.
- `src/stores/` — one store per contract, `deps` as the core's SQLite store of that contract. Every
  atomic operation is one statement or one transaction at `READ COMMITTED`; the isolation and the
  locking are stated in each store's doc comment. A lease's expiry is decided by the database's
  time (agbossjs/agboss#533): `clock_timestamp()` inside each statement that takes, renews, yields,
  reclaims, fences or closes a lease (`src/stores/store-time.ts`: `COALESCE($n::timestamptz,
clock_timestamp())`, the parameter the test's clock only when `StoreClock.source` is
  not `StoreTimeSource.Database`); every take and renewal answers `remaining`. Other times (records, retention) come from the
  application's clock, as parameters.
- Times of a pause (agbossjs/agboss#1307): `Date`s in memory, `timestamptz` columns bound as `Date`s, every
  time in a text column or JSON the `toISOString()` text (never a `Date` into `text`/`jsonb`: node-postgres
  writes local time with an offset), read back canonical-only (`pauseRecordOfJson`, `instantOfText`);
  an Invalid Date is refused first (`assertPauseInstants`, `assertValidInstant`); the rules are the
  core's pure transitions, never restated; pool sessions are `timezone=UTC`.
- `src/cli.ts` + `bin/agboss-postgres.js` — the command.
- `tests/processes/` + `tests/fixtures/` — the two-process tests (#482 AC1–AC3, #483 AC1–AC4, the outbound charge, agbossjs/agboss#520 AC1):
  each instance a `node` child (`--import tsx`) running `ProcessApplication` on the test's schema,
  driven over stdin/stdout, serving A2A on a port of its own. Typed by `tsconfig.processes.json`
  (the generated flow types stay out of the other tests).

## Rules

- Import only `@agboss/core` public entries (`@agboss/core`, `/stores`, `/units`, `/testing`,
  `/testing/contracts`, `/eslint`); never `/internal`. When the core lacks a public seam a store
  needs, stop and report it on the issue.
- The core's limits: 200 lines per file, 50 per function, complexity 10; no `eslint-disable`,
  `@ts-ignore`, `as any`, `as unknown as`. Components keep no state (`agboss/no-component-state`),
  time from the `Clock` (`agboss/no-direct-time`).
- Every store runs its published contract suite through one `storeConformance`
  (`tests/contracts/store-conformance.test.ts`, agbossjs/agboss#526) against the real database,
  nothing left out (`without`); every migration path and every error has a test. Tests fail
  without a database, never skip.
- Conveyor, labels, branches and PRs as agbossjs/agboss (see CONTRIBUTING.md).
- Changelog: a fragment `changes/<issue>-<slug>.md` (`section:` + `issue:` header, entry mentioning
  `agbossjs/agboss#<issue>`; see `changes/README.md`), never an edit of `CHANGELOG.md` (CI fails it
  outside a `release/*` branch).
