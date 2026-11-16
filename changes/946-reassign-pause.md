---
section: Added
issue: 946
---

**An open pause can be reassigned** (agbossjs/agboss#946, core `app.reassignPause`):
`PostgresPausedExecutionRepository` implements `reassignByTenantIdAndPauseId` — one transaction: the
old pause row-locked and closed `Cancelled` / `Reassigned` with `reassignedTo`, its `closed` notices
written when it was sent, the replacement inserted `Pending` and unsent under the step key
`<original>~r<n>` (of two racing reassignments, or a reassignment and an answer, exactly one wins) —
and `findPendingUnsentReassignedBefore` (keyset `(askedAt, tenantId, pauseId)`, the re-send look's
read after a pod was killed between the write and the new message). The retention keeps a reassigned
pause while its replacement is stored. Migration `0035_pause_reassignment` adds the partial index of
that scan (no column). Migrate (`agboss-postgres migrate`) before rolling out.
