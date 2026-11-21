---
section: Changed
issue: 129
---

**The A2A direct-message store and the checkpoint saver are mutation-tested at 100 %** (agbossjs/agboss#129): two new shards, `a2a-direct` (the once-only claim, and a retake only after `expires_at`) and `checkpoints` (the latest checkpoint by step, and the version a branch gets); each store still left out of a shard names the guarantee it holds that a mutation run does not prove. No change to the stores.
