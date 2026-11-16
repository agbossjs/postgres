---
section: Fixed
issue: 1166
---

**A fenced effect's stored result that is not JSON fails with `StoredNamesUnreadableError`**
(agbossjs/agboss#1166): its replay threw a `SyntaxError` with no `code` whose message quotes the
stored text (the caller's data, agbossjs/agboss#906 D4-b). It is the coded error now
(`code: "stored.unreadable"`, the effect's name), its `cause` a `SyntaxError` that keeps no text.
