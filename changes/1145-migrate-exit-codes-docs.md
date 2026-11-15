---
section: Changed
issue: 1145
---

**The README says what exit `1` of `agboss-postgres migrate` means** (agbossjs/agboss#1145, after agbossjs/agboss#1102 and agbossjs/agboss#1116): exit `1` is "the migration failed" or "the migrations are applied, only the index step failed". The `migrate` section now lists the index-step failure line, how a script tells the two apart (`PostgresStepIndexError`, `code` `postgres.step-index-failed`, `report`, `invalidIndexLeft`), the INVALID-stays variant with the 3 s bound on the drop, and what to do when it keeps timing out (end the idle transaction on `checkpoints`, run `migrate` again). Documentation only.
