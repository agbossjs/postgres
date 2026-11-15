---
section: Fixed
issue: 1129
---

**`watchLivenessSeconds` and the URL's `connect_timeout` have an upper limit** (agbossjs/agboss#1129) — a value above 3600 s is refused with a `PostgresSettingsError` naming the field, on the settings object, in the environment (`postgresWatchLivenessSeconds`) and in the URL (`connect_timeout`); before, a value of 2147484 s or more overflowed Node's timer (2^31-1 ms) and the timer fired at once. The connection also copies the settings object it is given: changing it after construction no longer bypasses the check.
