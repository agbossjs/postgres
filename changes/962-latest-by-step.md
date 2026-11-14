---
section: Changed
issue: 962
---

**`PostgresCheckpointSaver.latestByStep`: a marked thread's latest checkpoint is one index walk**
(agbossjs/agboss#962): the core's optional `latestByStep` — the checkpoint of a thread's namespace
with the greatest `metadata.step`, ties by `checkpoint_id` by code unit (`COLLATE "C"`), a missing
or non-number step counting as -2 — reads the id from a new expression index on `checkpoints`
(`checkpoints_latest_by_step`) and the checkpoint by LangGraph's own read. `agboss-postgres migrate`
(and `migratePostgres`) builds the index after the migrations, `CREATE INDEX CONCURRENTLY` on a session
of its own behind a non-waiting `pg_try_advisory_lock`: a populated table keeps taking writes (1 000 000
rows: a 1.5 s build, no write held over 90 ms), a run that does not get the lock skips the step, a start
that migrates does not wait for it, an INVALID leftover is built again, and a read is correct without the
index, only slower. On 10 000 checkpoints a read went from 38 ms (list and sort) to 1.7 ms. The core's
`StoreCapability.LatestByStep` conformance case joins `store-conformance` at the next core repin.
