---
section: Changed
issue: 1038
---

**`agboss-postgres migrate` says what it did to the checkpoint index** (agbossjs/agboss#1038, after
agbossjs/agboss#962): the command printed only the numbered migrations ("nothing to apply … at
migration 31"), so an operator could not tell whether `checkpoints_latest_by_step` had been built.
Its last line now says it: `built index checkpoints_latest_by_step (<schema>)`, `index … is ready`
(found valid), or `skipped index …: another run holds its build lock; run migrate again when it
ends`. `migratePostgres` returns the same in `MigrationReport.stepIndex` (`StepIndexResult`:
`"built"`, `"present"`, `"skipped"`), unset when the run did not wait for the index (a start that
migrates builds it in the background).
