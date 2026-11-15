---
section: Fixed
issue: 1116
---

**`agboss-postgres migrate` no longer waits for another transaction to drop an INVALID checkpoint
index** (agbossjs/agboss#1116, after #1102): `DROP INDEX CONCURRENTLY` waits for every transaction
that holds a lock on `checkpoints`, an idle reader included, so after a cancelled build the run
could wait for hours (44 s with a session idle in a transaction, the blocker's lifetime). The drop
now runs under a `lock_timeout` of 3 seconds. When it gives up, the INVALID index stays, the run
ends with exit 1 and the build's own cause, and the line says `an INVALID index
checkpoints_latest_by_step stays: the next migrate run drops and rebuilds it`
(`PostgresStepIndexError.invalidIndexLeft`). The drop at the start of the next run has the same
bound. Both drops stay `CONCURRENTLY`: no write to `checkpoints` waits for them.
