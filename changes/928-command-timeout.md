---
section: Added
issue: 928
---

**Every store command is bounded** (agbossjs/agboss#928, agbossjs/postgres#96): the pool sets
`statement_timeout` (the environment's `postgresCommandTimeoutMs`, settings `commandTimeout`;
default `DEFAULT_COMMAND_TIMEOUT`, 10 s; 100 to 30 000 ms, 0 refused) and `query_timeout` a second
later. A command that does not answer is `StoreCallTimeoutError` (`store.call-timeout`, source
`Command`), its outcome unknown: under a lease the holder hands the tree over. A connection lost
under a COMMIT or a single write is `StoreOutcomeUnknownError` (source `Transport`,
agbossjs/agboss#1017); a statement inside a transaction or a read stays an ordinary error. After a
client-side timeout the socket is destroyed and no `ROLLBACK` is queued behind the hung statement.
Retention deletes (`delete…Before`) run under `LONG_COMMAND_TIMEOUT` (5 min). A session idle in a
transaction is ended by the server after `postgresIdleInTransactionTimeoutMs` (settings
`idleInTransactionTimeout`, default 10 s): a frozen holder's lease row lock is freed, so `app.cancel`
and a takeover are not held by it. A URL's `connect_timeout=0` is now a `PostgresSettingsError`
(it read as the 10 s default), `connect_timeout=1` is 2 s as in libpq. No migration.
