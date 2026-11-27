---
section: Fixed
issue: 1341
---

**A reclaim under an `Immediate` pause inherits the fence** (agbossjs/agboss#1341c): the reclaim's one statement (and `syncClusterLease(lease, { isReclaim: true })`'s upsert) raises `fenced_through_token` to `GREATEST(itself, token + 1)` while `is_externally_paused` and `external_pause_mode = 'immediate'`, so the holder's first write on the reclaimed token is refused and it parks; under an `AfterStep` pause or after `unpause` the fence stays.
