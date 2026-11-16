-- agbossjs/agboss#946: a pause can be reassigned to another addressee. The replacement is a pause of
-- its own (`reassignedFrom` in its record, `assignee`, unsent until its channel was asked again); the
-- old one is `cancelled` / `reassigned` with `reassignedTo`. The re-send look reads the replacements
-- whose channel was never asked (a pod killed between the write and the send): `Pending`, unsent,
-- `reassignedFrom` set, by `(askedAt, tenant, pause)` with a keyset — the partial index has that key,
-- its order, and holds only those rows. No column is added: the fields live in the record.
-- Run once no instance of an earlier version runs (ADR-0034); written to rerun.
CREATE INDEX IF NOT EXISTS agboss_pauses_reassigned_unsent
  ON agboss_pauses ((record->>'askedAt') COLLATE "C", tenant_id COLLATE "C", pause_id COLLATE "C")
  WHERE status = 'pending' AND record ? 'reassignedFrom' AND record->>'isSent' = 'false';
