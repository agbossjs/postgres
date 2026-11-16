---
section: Fixed
issue: 954
---

**An instance's stop against a quiet PostgreSQL leaves no connection open** (agbossjs/agboss#954) — `PostgresConnection.onDestroy` waited for `pool.end()`, which returns only when every client is back: a client in the middle of a statement the server never answers never was, and an idle one's graceful end waits for the server too. It now drops every client's socket (statements in flight reject) and does not wait for them; the child queue's LISTEN connection a stopped worker never closed is dropped with it, and after the stop begins no listener opens or reconnects.
