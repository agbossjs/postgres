---
section: Changed
issue: 1104
---

**A schema upgrade is stop the old version, migrate, deploy** (agbossjs/agboss#1104, ADR-0034).
`agboss-postgres migrate` and `migratePostgres` refuse when migrations are pending and an execution
lease is live on the database's clock (not released, finished or superseded, not expired): they
apply nothing and fail with the new `PostgresLiveLeasesError` (`code: "postgres.live-leases"`, the
`count` and up to five `holders`). `--allow-live-leases` / `allowLiveLeases: true` migrates anyway;
a run with nothing to apply still exits `0`. An idle old instance holds no lease, which the README
says. Migration `0033` makes `agboss_pauses.channel` a stored generated column of
`record->>'channel'`: a pause an old instance inserts without it (the insert before this version)
is now in a channel-filtered page; the store no longer writes the column. The README replaces the
Helm `pre-upgrade` example (scale to zero, Job, deploy) and restricts hooks to upgrades that apply
no migration.
