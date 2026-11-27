---
section: Fixed
issue: 1321
---

**A chain of checkpoint writes keeps the tree's root, and the root-id setup no longer deadlocks with the step-index build** (agbossjs/agboss#1321d, #962): `put` answers the config with the `root_execution_id` it was given, so the next `put` of the chain (LangGraph passes the answer on) stores the same root — before, its row was given the thread id's first segment by the table's trigger, which deleted a thread of another tree whose id merely looks like a child's. The setup's `ALTER TABLE` / `CREATE INDEX` of `root_id` (locks even when nothing changes) runs only when the catalog says a part is missing, so a second concurrent migration never waits for a `CREATE INDEX CONCURRENTLY` that waits for it.
