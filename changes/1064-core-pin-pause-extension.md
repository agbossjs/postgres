---
section: Changed
issue: 1064
---

**On the core's pause contract of agbossjs/agboss#942, #1099 and #941** (agbossjs/agboss#1064):
`extendByTenantIdAndPauseId` takes a `PauseDeadlineChange` and is one compare-and-set over the
deadline the caller read (`previousExpiresAt`) to a later one — the loser gets `undefined` and
re-reads; `findPendingByExpiresAtBefore` and `findPendingByRemindAtBefore` take a keyset `after`
`(at, tenantId, pauseId)`; `renewNotice` renews a notice claim while its receiver runs, only for
its token and while it holds (agbossjs/agboss#1131). The `checkpointSaver` declares `StoreCapability.LatestByStep`
(agbossjs/postgres#90). No migration.
