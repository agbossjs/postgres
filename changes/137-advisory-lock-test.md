---
section: Fixed
issue: 137
---

**The test of a business key's advisory lock kills its mutant on every run** (agbossjs/agboss#137, agbossjs/agboss#1367): "two business keys of one tenant do not wait on each other" started the slow call without waiting for it to take its lock, so a mutant that gave every key one lock survived when the fast call locked first (3 failures in 8 runs; `mutation effects-and-calls` was red on main at 99.48 %). The slow effect's work now signals that it runs, which is after the lock is taken, and the fast call starts only then. No change to the store.
