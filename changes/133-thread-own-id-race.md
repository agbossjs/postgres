---
section: Changed
issue: 133
---

**The race on a caller's own thread id is pinned by a behavioural test** (agbossjs/postgres#133, agbossjs/agboss#133): `createThread` with the caller's `threadId` is `INSERT ... ON CONFLICT DO NOTHING`, and no test caught a last-writer-wins or a read-then-write version of it. A new test has 4 writers on connections of their own, released together, create one id for 8 rounds. A trigger of the test's own schema logs every write to the thread row: exactly one `INSERT` and no overwrite, the stored owner is that insert's, and every racer reads it back. `createThread` is in the `execution-records` shard, which stays at 100 %. No behaviour changed.
