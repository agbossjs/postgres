---
section: Fixed
issue: 1327
---

**The outbound call's close names the lease's token again** (agbossjs/agboss#1327): the previous
change removed the `token` clause of `CLOSE` as true in every state under `LOCK_LEASE`'s row lock. It is
restored as the last guard should that lock be dropped or reordered, as a constant of its own with a
reasoned `Stryker disable` (no test can fail without it while the lock holds). Behaviour unchanged.
