---
section: Changed
issue: 1117
---

**A tree's cancel mark is permanent and lives on its lease row** (agbossjs/agboss#1117, replaces the
retention rule of #909): migration `0034_cancel_mark_on_lease_row` adds
`agboss_execution_leases.cancel_requested_at`, moves the marks of `agboss_execution_cancel_requests`
onto the lease rows (a tree with no row gets a seed row: token 0, released, never held; the first
`acquire` is token 1 and no takeover; the token's CHECK now allows 0), and drops the table. No
retention, release, retire or takeover lifts a mark, so a child of a cancelled tree — live, or taken
later — is refused for good; the fencing stores' retention no longer touches marks. The fence is the
root row's lock, not advisory lock 909: `requestCancel` writes the mark with an upsert, which waits
for the share locks of the tree's open fencing transactions; a fenced write reads the mark with
`SELECT … FOR SHARE` on the root's row (a child's check seeds the root's row first when there is
none). **Stop every instance, migrate, then deploy**: an older instance writes the dropped table and
the migration runs under the live-lease guard (agbossjs/agboss#1104).
