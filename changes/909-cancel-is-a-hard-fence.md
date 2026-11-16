---
section: Changed
issue: 909
---

**Cancel is a hard fence for effects** (agbossjs/agboss#909): `PostgresExecutionLeaseRepository.requestCancel(tree)`
writes the tree's durable cancel mark (migration `0032_execution_cancel_requests`, the table
`agboss_execution_cancel_requests`: tenant, root, `requested_at`) and the fenced-effect and
outbound-call stores read it in their own transactions, after the lease row, the scope's mark and,
for `runOnce`, the key's lookup, under a pair of advisory locks of the tree's identity (namespace
909, beside the business key's 508): a cancel takes the exclusive one and waits for the tree's open
fencing transactions, a fencing transaction takes the shared one and reads the committed mark. A new
effect, intent (`saveIfAbsent`) or attempt (`markPending`) of a cancelled tree is refused with the
core's `ExecutionCancelFencedError`; a stored result, an undo's key and the end of a claimed attempt
are not. The mark's table and its advisory locks are replaced by the lease row (agbossjs/agboss#1117). Migrate (`agboss-postgres migrate`)
before rolling out: an older instance neither writes nor reads the table.
