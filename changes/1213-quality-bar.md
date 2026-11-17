---
section: Changed
issue: 1213
---

**The package meets the core's quality bar** (agbossjs/agboss#1213): the money-path modules — the lease, its fence and cancel mark, the fenced effects and outbound calls, the pause store and its notices, the ledger, rate limits and child queue, the migrations, the store-call bound and its outcome classification — are mutation-tested with Stryker at 100 % killed or justified (`MUTATION_SHARD=<shard> npm run test:mutation`; CI runs each shard incrementally, cold when its setup changes, a nightly run cold); `npm run check:static` is the cheap half of the gate (the root allowlist, knip, the README's ts blocks compiled against the build, lint, types, the API report); the lint forbids `@agboss/core/internal`, the core's testing entries in `src/`, a faked interrupt and a synchronous child process in a test. No change to the stores' behaviour.
