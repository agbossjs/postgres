---
section: Changed
issue: 129
---

**Every Stryker disable hides exactly one mutant, and every module is in a mutation shard or named as not** (agbossjs/postgres#129, written agbossjs/agboss#129 as the fragment check wants it; agbossjs/agboss#1353): `check:suppressions` (so `npm run check`) runs `scripts/stryker-disables.mjs`, the core's, on the `@stryker-mutator/instrumenter` Stryker itself uses: only `// Stryker disable next-line <Mutator>: <reason>` (no `disable all`, no range), exactly one mutant ignored on the line below, a file's ignored mutants are its disables; no allowlist. `tests/scripts/mutation-shards-complete.test.ts` fails for a `src/` module that no shard's `mutate` covers and `NON_SHARDED_SRC` (`scripts/mutation-shards.mjs`) does not name with its reason. `src/connection/tracked-client.ts` and
`src/connection/once.ts` are mutated in the `store-bound` shard at 100 %. Behaviour is unchanged: the abort listener of the
queue watch is added without `{ once: true }` (the signal aborts once), which left two mutants under one disable.
