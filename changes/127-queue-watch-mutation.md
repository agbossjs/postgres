---
section: Changed
issue: 127
---

**The child queue's `LISTEN` watch is mutation-tested** (agbossjs/postgres#127, written agbossjs/agboss#127 as the fragment check wants it; the #1213 bar):
`src/connection/listener.ts` and the two helpers it owns, `heartbeat.ts` and `drop-client.ts`, are
the new `queue-watch` shard of `scripts/mutation-shards.mjs`, with its own job in the PR and the
nightly runs; every mutant is killed or justified where it stands. Behaviour is unchanged: the
reconnect pauses (1, 2, 4, 8, 16, then 30 s) are read from a list and a constant, and
`watchLiveness` reports a dead connection through an `onDead` callback instead of its result.
