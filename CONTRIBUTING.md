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

`@agboss/postgres` is versioned with `@agboss/core` and published right after it, by the maintainer
only (agbossjs/agboss `RELEASE_CHECKLIST.md` is the ordered list; agbossjs/agboss#691):

1. Once `@agboss/core@X.Y.Z` is on npm, pin it — `node scripts/pin-framework.mjs --registry X.Y.Z`
   (`.agboss-version.json` `source: "registry"`: `npm run pack:framework` then downloads the
   registry's tarballs and checks their integrity) — and bump `package.json` to `X.Y.Z` with the
   peer dependency `^X.Y.Z`, in one PR; its CI runs everything on the published core.
2. After it is merged and `main`'s CI is green, push the tag `postgres-vX.Y.Z` on that commit.
   `.github/workflows/release.yml` checks the tag, the version, the pin and that CI passed on the
   commit, then publishes with provenance (`NPM_TOKEN` of the `npm` environment).
3. Back to a commit pin for development: `node scripts/pin-framework.mjs --sha <agboss main sha>`.

A pull request that touches the release path runs the workflow's dry run (`npm publish --dry-run`).
