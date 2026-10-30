# Contributing

`@agboss/postgres` follows the conveyor of [agbossjs/agboss](https://github.com/agbossjs/agboss):
every change starts as an issue there (stage = its `status:*` label: Triage → Backlog → In progress
→ Test → Done, Done only by a human closing it) and lands here through a squash-merged PR.

## Before a PR

1. A PostgreSQL for the tests (they fail without one):
   `docker run -d -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16` and
   `export AGBOSS_POSTGRES_TEST_URL=postgres://postgres:pw@localhost:5432/postgres`.
2. `npm ci && npm run pack:framework && npm run install:packed` — the core at the pinned SHA.
3. `npm run check` — the gate CI runs too (with a `postgres:16` service).

## Branches, commits, PRs

- Branch from `main`: `<type>/<issue>-<slug>` (`feat/482-postgres-stores`).
- Conventional commits naming the issue: `feat(#482): …`, `fix(#482): …`, `test(#482): …`.
- The PR body says `Refs agbossjs/agboss#<issue>`; it is squash-merged when CI is green.
- Labels: `type:feature` · `type:bugfix` · `type:chore` · `prio:mvp` · `blocked`, as the core.

## Changing the schema

A schema change is a new `migrations/NNNN_<name>.sql` (the next number, no gaps). An applied
migration never changes — its checksum is recorded and a changed file fails every run. Add a test
for the new migration path, and run `npm run api:update` when the public API changes.

## Releasing

`@agboss/postgres` is versioned with `@agboss/core` (a peer dependency range) and published right
after it. Before that, `npm run install:published` checks the package against the registry's core.
