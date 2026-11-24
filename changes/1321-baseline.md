---
section: Breaking
issue: 1321
---

**One 0.1.1 baseline migration** (agbossjs/agboss#1321c): migrations `0001`-`0035` of 0.1.0 are squashed into `0001_baseline_0_1_1.sql`, the schema they ended in, every statement `IF NOT EXISTS`. A 0.1.0 database is not migrated; the lease guard reads the baseline's `finished` and `superseded` columns without a version check (`refuseLiveLeases(client)`, `waitForLeasesToLapse(client, wait)`). Each store train that changes a table adds the next numbered file, when the train is cut.
