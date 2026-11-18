---
section: Fixed
issue: 1327
---

**Every lock, tenant and token clause of the money-path SQL is proven by a test** (agbossjs/agboss#1327):
Stryker replaces a whole SQL string with `""` and never drops a clause inside it, so a mutation shard
at 100 % said nothing about a `FOR UPDATE`, a `SKIP LOCKED`, a tenant predicate or an `ON CONFLICT`
target in a statement. A sweep that dropped each clause of the `effects-and-calls`, `pauses`, `money`
and `migrations` shards in turn found the clauses no test missed. Each now has a test that fails
without it, and the lock, the conflict target and the guards of the statements that matter are
constants of their own, so the shard drops them too. Two-tenant tests stand for the tenant predicates:
the answer to a pause, the reassignment, the paused run, the business key's effect and the child's
claim of one tenant never touch another's. Clauses that no behaviour needed are removed (`WHERE id` of
the one-row pruning mark, the `RETURNING` of a slot's insert, a `NOT NULL` test beside a comparison
that is never true of NULL). The statements' behaviour is unchanged. No migration.
