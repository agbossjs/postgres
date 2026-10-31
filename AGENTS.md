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
- `npm run check` — format, suppressions (budget 0), flow types (`check:types`: the CLI's
  `agboss check` on `tests/fixtures/`, writes the uncommitted `.agboss/types.d.ts`), lint, types,
  tests with coverage, API report.
- `npx agboss-postgres migrate --url <url>` — the migrations (after `npm run build`).

## Architecture

- `src/connection/` — `PostgresConnection` (DI token, `deps: [ApplicationContext]`, or
  `new PostgresConnection({ url })` in a script/test), its settings from the environment
  (`postgresUrl: Secret`, `postgresPoolSize`, `postgresMigrateOnStart`), the query helpers (rows
  as `unknown`, validated by each store) and the transaction helper (a pool of one never deadlocks).
- `src/migrations/` — `migrations/NNNN_<name>.sql` read and checksummed, the history table, the
  advisory-locked run (`migratePostgres`), the start check (`PostgresSchemaMissingError` /
  `PostgresSchemaTooNewError`). A schema change is always a new file; an applied file never changes.
- `src/stores/` — one store per contract, `deps` as the core's SQLite store of that contract. Every
  atomic operation is one statement or one transaction at `READ COMMITTED`; the isolation and the
  locking are stated in each store's doc comment. Time only from the `Clock` (parameters, never
  `now()`).
- `src/cli.ts` + `bin/agboss-postgres.js` — the command.
- `tests/processes/` + `tests/fixtures/` — the two-process tests (#482 AC1–AC3, #483 AC1–AC4, the outbound charge):
  each instance a `node` child (`--import tsx`) running `ProcessApplication` on the test's schema,
  driven over stdin/stdout, serving A2A on a port of its own. Typed by `tsconfig.processes.json`
  (the generated flow types stay out of the other tests).

## Rules

- Import only `@agboss/core` public entries (`@agboss/core`, `/units`, `/testing`,
  `/testing/contracts`, `/eslint`); never `/internal`. When the core lacks a public seam a store
  needs, stop and report it on the issue.
- The core's limits: 200 lines per file, 50 per function, complexity 10; no `eslint-disable`,
  `@ts-ignore`, `as any`, `as unknown as`. Components keep no state (`agboss/no-component-state`),
  time from the `Clock` (`agboss/no-direct-time`).
- Every store runs its published contract suite (`tests/contracts/*.contract.test.ts`) against the
  real database; every migration path and every error has a test. Tests fail without a database,
  never skip.
- Conveyor, labels, branches and PRs as agbossjs/agboss (see CONTRIBUTING.md).
