---
section: Added
issue: 1321
---

**`PostgresDriver`, and a tree's checkpoints deleted by their stored root** (agbossjs/agboss#1321d, #1321f): `@DatabaseStorage({ driver: PostgresDriver({ url: secret("POSTGRES_URL"), schema, poolSize, timeouts }) })` brings the connection and every store, with the lease store and the coordination stores named and `agboss migrate db` wired to `migratePostgres` (`StorageMigrate`, refusing live leases unless `--allow-live-leases`); the environment's `postgres…` fields stay for an application without a storage component. `PostgresCheckpointSaver.deleteThread(rootExecutionId)` deletes the thread and every thread whose stored `root_id` is it — never by a range or a prefix of thread ids: `checkpoints` and `checkpoint_writes` get a `root_id` column and an index after `PostgresSaver.setup()` (a step of the setup, not a numbered migration), written from `configurable.root_execution_id` after each write, a row written without it taking its thread id's first segment by a trigger.
