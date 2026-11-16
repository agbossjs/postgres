---
section: Changed
issue: 1104
---

**`SchemaSetup.MigrateOnStart` follows the rule too** (agbossjs/agboss#1104, ADR-0034: no rolling
upgrade across a schema change). A start with migrations pending on an already-migrated schema waits
up to a minute for live execution leases to lapse (a stopped single instance's own do) and fails with
`PostgresLiveLeasesError` while one is live, so a rolling restart over a running old pod is refused.
No pending migration: no check. `allowLiveLeases: true` in `PostgresConnectionSettings` keeps the
override (`postgresAllowLiveLeases: true` in the application's environment).
