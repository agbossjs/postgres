-- agbossjs/agboss#1104: a pause's channel is the record's, whoever wrote the row. 0031 added
-- `channel` as a column the store filled on insert and a one-shot UPDATE backfilled: an instance of
-- an earlier version still writing after that left rows with a NULL channel, which a channel-filtered
-- page never returned. Now `channel` is a stored generated column of `record->>'channel'` (the
-- record stays the one source): an insert that omits it — an old instance's — gets it, and NULL is
-- impossible for a record that names one. The store no longer writes the column.
-- A generated column cannot be altered into place: it is dropped (the index on it with it) and added
-- again, the index recreated, in this migration's one transaction. Every row's channel is computed
-- again by the table rewrite. Run it once no instance of an earlier version runs (ADR-0034): the
-- table is locked for the rewrite. Written to rerun: drops and creates are IF [NOT] EXISTS.
DROP INDEX IF EXISTS agboss_pauses_by_tenant;
ALTER TABLE agboss_pauses DROP COLUMN IF EXISTS channel;
ALTER TABLE agboss_pauses
  ADD COLUMN channel text GENERATED ALWAYS AS (record->>'channel') STORED;
CREATE INDEX IF NOT EXISTS agboss_pauses_by_tenant ON agboss_pauses (tenant_id, status, channel, seq);
