---
section: Changed
issue: 1367
---

**A Stryker Timeout of the clock that is not listed is run again alone before it fails a mutation job** (agbossjs/agboss#1367, agbossjs/mongodb#103): which static mutants end as Timeouts moves from run to run on a loaded CI runner, so a list only hides it. `scripts/stryker-timeouts.mjs --rerun` (wired into `ci.yml` and `mutation-nightly.yml` for every shard) runs each such mutant again in a fresh Stryker process (`--concurrency 1 --force --mutate <file>:<lines>`, the shard's own config and servers, a 10 min `timeoutMS`, its own report, incremental file and temp dir): Killed is told and passes; Survived, a second Timeout of the clock, an error or a mutant the rerun does not find fails, unless the mutant is listed. A listed mutant is not rerun and keeps its rules (a Survived one, a stale entry, fails); more than 10 unlisted Timeouts of the clock is no flake and fails without a rerun. The script and its helper `scripts/stryker-rerun.mjs` are the core's, byte for byte. Test-only and CI changes; no product behaviour changes; no migration.
