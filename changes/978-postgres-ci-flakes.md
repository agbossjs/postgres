---
section: Fixed
issue: 978
---

**The test suite no longer meets "too many clients already" or a wall-clock margin** (agbossjs/agboss#978): one file's rounds held 90 pools at once; a test file's pools are now bounded (`connectionTo`'s budget) and a round's end theirs, and the run's peak of connections is sampled and asserted under a fixed bound. `database-time.test.ts` bounds `remaining` by the database's own clock, not by a millisecond a loaded machine can break. The orphan sweep's single statement (agbossjs/agboss#960) is pinned by a test. Test-side only: no change to the package's behaviour, no migration.
