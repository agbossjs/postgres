---
section: Fixed
issue: 1017
---

**A COMMIT or a single write is a definite failure only when the error proves nothing was applied** (agbossjs/agboss#1017, agbossjs/postgres#113): the classifier was a blacklist of nine transport codes, so `08007`, `08P01`, `XX000` (a pooler's dropped upstream), `53100`, `58030`, `57P04`, `ECONNABORTED`, `EHOSTUNREACH`, TLS and stream errors at COMMIT were read as known failures, and the step failed and undid work after a charge that may have committed. Now only pg's never-sent errors and a server abort of a whitelisted SQLSTATE class (`09`, `21`, `22`, `23`, `25` but `25P03`/`25P04`, `2F`, `38`, `40` but `40003`, `42`, `44`, `P0`), with severity `ERROR`, of one statement (not a `CALL`, a `DO` or several statements), are known; everything else after the send is `StoreOutcomeUnknownError`. A connection of unknown outcome is ended at once: the pool never hands it out again, and every later statement on it (LangGraph's `PostgresSaver` rolls back in its own `catch`) rejects with that same outcome. `pool.query` with a query config is read as the text form is. No migration.
