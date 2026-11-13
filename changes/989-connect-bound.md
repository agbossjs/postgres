---
section: Fixed
issue: 989
---

**No store call waits forever for its connection** (agbossjs/agboss#989): a statement waited for a
connection that never answered its start — a black-holed network, a proxy that drops the forward,
a socket connected to itself — forever. It now rejects with `pg`'s connection timeout after the
URL's `connect_timeout` (libpq's, whole seconds), else `DEFAULT_CONNECT_TIMEOUT` (10 s): the pool,
the child queue's `LISTEN` connection and `migratePostgres`. The test setup pins `localhost` to the
address the server answers on, so a test connection cannot connect to itself (what hung the
interleaving explorer for 17 minutes). The bound of a statement's own run time is
agbossjs/agboss#928. No migration.
