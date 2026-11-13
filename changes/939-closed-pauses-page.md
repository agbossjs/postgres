---
section: Changed
issue: 939
---

**`findClosedByResolvedAtBefore(cutoff, limit, after?)` returns a page** (agbossjs/agboss#939):
`PostgresPausedExecutionRepository` lists what the retention would remove — closed, resolved before
the cutoff, with no live mailbox — in insertion order (the `bigserial` `seq`) a page at a time, with
the opaque cursor of `findOpenAfter`, so the retention repairs every missing answer-log entry before
its one removal, whatever the backlog. `deleteByTenantIdAndThreadIdAndRunId` (the tree end's delete of
the paused run) came with the pause store contract v2. No migration.
