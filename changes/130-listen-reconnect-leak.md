---
section: Fixed
issue: 130
---

**A reconnect of the child queue's `LISTEN` watch no longer leaves the old connection attached** (agbossjs/postgres#130, written agbossjs/agboss#130 as the fragment check wants it): every connection added its drop to the listener's own signal, which only `destroy()` aborts, so each reconnect (a proxy that drops idle connections, a failover loop, the liveness ping) kept its `pg.Client` and `Socket` reachable for the life of the process, up to about 2,900 a day. A connection's drop now leaves the signal when its socket closes. A test makes five reconnects, and as many failing attempts, and counts the listeners on the signal.
