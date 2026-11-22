---
section: Changed
issue: 133
---

**The execution tree store is a mutation shard at 100 %, and its "not sharded" reason is gone** (agbossjs/postgres#133, agbossjs/agboss#133): the new `execution-tree` shard mutates `postgres-execution-tree.repository.ts`: `saveIfAbsentInTree` (`INSERT ... ON CONFLICT DO NOTHING RETURNING`), the read of a key, and the delete of one tree. The reason the file was left out ("its writers hold the lease") was false: the public `ExecutionTreeRepository.saveIfAbsent` is called by user code in any execution of the tree, a child on any instance, with no lease of the root, and the child-failure claim of the core's re-entry is written by passes that overlap during a lease takeover, so the store's own insert is the only guard. A race test has 4 writers on connections of their own, released together, save one key: exactly one wins and its value is kept. With this, every store #133 listed is a shard. No behaviour changed.
