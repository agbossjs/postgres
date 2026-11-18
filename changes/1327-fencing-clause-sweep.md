---
section: Fixed
issue: 1327
---

**Every tenant, holder and token clause of the lease and fence statements is proven by a test**
(agbossjs/agboss#1327): the sweep that dropped each clause of the `money` and `pauses` shards in turn
now covers the non-lock clauses of the `fencing` shard. The clauses that named a lease or a scope
(the tenant and the root, the holder and the token of a renewal, a yield, a reclaim, a release and a
retire; the fence's and the cancel check's tenant; the outbound call's close), the lease row's lock
footprint, what a take clears, the mark's refreshed time and the two `ON CONFLICT` targets had no
test that failed without them. Each has one now (two trees of two tenants that share a root id; a
second unique key whose violation must be an error) and the take's clean-up, the mark's time and the
conflict targets are constants of their own, so the shard drops them too. One clause is removed:
the token of the outbound call's close, which the same transaction had just read under the row's
lock. The statements' behaviour is unchanged. No migration.
