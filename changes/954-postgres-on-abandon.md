---
section: Added
issue: 954
---

**`PostgresConnection` has `onAbandon()`** (agbossjs/agboss#954, core `OnAbandon`): a stop that abandons its `onDestroy` destroys the listeners' and the pool's sockets, synchronously, and ends the pool.
