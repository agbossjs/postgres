---
section: Fixed
issue: 1102
---

**`agboss-postgres migrate` tells the truth when only the checkpoint index step fails**
(agbossjs/agboss#1102, after #1038): a cancelled `CREATE INDEX CONCURRENTLY`, or a role that may
migrate but does not own `checkpoints`, made the command print "the migration failed" and drop every
`applied …` line, though the numbered migrations and LangGraph's setup had committed. It now lists
what the run applied (or `nothing to apply …`), then prints `index checkpoints_latest_by_step
(<schema>) failed: <cause>; …` and exits 1 as before. An INVALID index the failed build left is
dropped when the session may; otherwise the next `migrate` drops it and builds the index again
(reads are correct meanwhile, `latestByStep` slower). `migratePostgres` rejects with the new
`PostgresStepIndexError` (`code: "postgres.step-index-failed"`, `report`: what the run applied), so a
script tells "schema not migrated" (any other error) from "index not built".
