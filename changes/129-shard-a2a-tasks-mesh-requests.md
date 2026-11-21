---
section: Changed
issue: 129
---

**The A2A task store and the mesh request store are mutation-tested at 100 %** (agbossjs/agboss#129): two new shards, `a2a-tasks` (the once-only claim of a message, which the direct-message store shares and which makes an A2A accept once-only, the task's compare-and-set, the page of `list`) and `mesh-requests` (`saveIfAbsent`, the guarantee behind MCP dedupe); the execution record and execution tree stores stay unsharded, their reasons saying that their compare-and-set runs under the held lease, which is the fence. No change to the stores.
