---
section: Fixed
issue: 789
---

**The child queue's `LISTEN` notices a connection that dies silently** (agbossjs/agboss#789) — a
half-open TCP connection (a NAT or a load balancer that lost its state: no FIN, no RST) no longer
stops the wake-ups of #777 with no sign. The watch pings its connection (`SELECT 1`, plus TCP
keepalive) and, when it is not answered within `postgresWatchLivenessSeconds` (default 10 s, at
least 2: `PostgresConnectionSettings.watchLivenessSeconds`), logs `child-queue.watch-connection-lost`
at `warn`, listens again on a new connection and wakes the claimers once. Every timer is on the
`Clock`. `PostgresChildExecutionQueueRepository` takes the `Logger` as its fourth dependency.
