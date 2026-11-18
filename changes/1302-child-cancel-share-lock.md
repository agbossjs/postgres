---
section: Fixed
issue: 1302
---

**A child's fenced write holds its root's cancel row for share, and a test proves it** (agbossjs/agboss#1302):
a fenced write of a child placed `AnyInstance` reads its root's cancel mark `FOR SHARE`, the only
lock it holds on the root's lease row, so a cancel of the root answers and commits its mark only
after the child's write ends. The behaviour is unchanged; until now no test failed and no mutant
existed without the lock. The lock clause is now its own constant in the `fencing` mutation shard,
and a two-connection test kills the mutant that drops it. No migration.
