---
section: Changed
issue: 129
---

**The execution record store is a mutation shard at 100 %** (agbossjs/agboss#129): the new shard `execution-records` mutates `postgres-execution-record.repository.ts` and `records/*.ts`. Its status write, `completeIfStatus` (`UPDATE ... WHERE status = $expected`), is the only guard of the paused -> running mark that a resume's first phase and a channel's decision write on whichever instance got the answer, before and without any lease, so the earlier reason that the lease epoch fences it was false; the store is out of `NON_SHARDED_SRC`, and the reason of the execution tree store, re-checked at the pinned core, names what each of its writers relies on. New tests: two instances marking one paused record running at once (exactly one lands), the 100 ids a minted thread tries, `ping`. The record column list is an array, so the aliased list is no string split. No change in behaviour.
