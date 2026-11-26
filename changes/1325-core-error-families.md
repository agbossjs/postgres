---
section: Breaking
issue: 1325
---

**The store errors are the core's `StoreError` variants** (agbossjs/agboss#1325, #909): a command timeout is `StoreError.CallTimeout` (`store.call-timeout`; a variant of its own, no longer a subclass of `StoreError.OutcomeUnknown` — test both with `isStoreOutcomeUnknown(error)` from `@agboss/core/stores`), a lost answer is `StoreError.OutcomeUnknown`, each with its facts `store`, `operation`, `source`; an unreadable stored record is `StoreError.UnreadableRecord` (`store.unreadable-record`, was `stored.unreadable`); an entry the ledger may have pruned is `StoreError.LedgerEntryExpired` (`store.ledger-entry-expired`, was `cost-ledger.entry-expired`); a write after its tree's cancel is refused with `cancelFencedOf(key)`, an `ExecutionError.CancelFenced`; minted ids that are all taken are `ExecutionError.ThreadIdsExhausted`. The `Stored…`, `Store…Error`, `CostLedger…Error` and `ExecutionCancelFencedError` classes are gone from the core. No migration.
