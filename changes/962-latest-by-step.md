---
section: Changed
issue: 962
---

**`PostgresCheckpointSaver.latestByStep`: a marked thread's latest checkpoint is one index walk**
(agbossjs/agboss#962): the core's optional `latestByStep` — the checkpoint of a thread's namespace
with the greatest `metadata.step`, ties by `checkpoint_id` by code unit (`COLLATE "C"`), a missing
or non-number step counting as -2 — reads the id from a new expression index on `checkpoints`
(`checkpoints_latest_by_step`) and the checkpoint by LangGraph's own read. `agboss-postgres migrate`
(and `migratePostgres`) makes the index after LangGraph's setup, `CREATE INDEX CONCURRENTLY`, safe
on a populated table and on every re-run (an INVALID leftover is made again); see "Migrations" in
the README. On 10 000 checkpoints a read went from 38 ms (list and sort) to 1.7 ms. The core's
`StoreCapability.LatestByStep` conformance case joins `store-conformance` at the next core repin.
