---
section: Fixed
issue: 1302
---

**Every row lock of the fence is proven by a test and a mutant** (agbossjs/agboss#1302): a fenced
write of a child placed `AnyInstance` reads its root's cancel mark `FOR SHARE`. That is the only
lock it holds on the root's lease row, so a cancel of the root answers and commits its mark only
after the child's write ends. The fence's `FOR UPDATE` on the child's own lease row makes a renewal
or a takeover of that lease wait for the write. The take's read of the lease before it waits for a
release in progress, so a released lease is never named as taken over. The behaviour is unchanged.
Until now, dropping the first two locks left every test green and made no mutant: Stryker replaces
a whole string, never a clause inside SQL. Each lock clause of the `fencing` mutation shard is now a
constant of its own, and two-connection tests kill the mutants that drop them. No migration.
