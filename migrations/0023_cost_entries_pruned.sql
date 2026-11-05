-- agbossjs/agboss#771: the ledger's entries are pruned. This also corrects 0022's header, kept as
-- it is because a migration is checksummed: an entry's ledgerId is an id of the pass that made the
-- spend (a random prefix of the pass and a number), never derived from where it was made. A step run
-- again after a crash or a takeover makes its spend again under new ids, and counts again. Only
-- the pass that made a spend saves its entry — its write and its retries after a lost answer —, so
-- an entry is needed only while that pass may still retry.
--
-- Each entry is dated by its record's madeAt. The recovery sweep prunes those made before
-- now − ledgerEntryRetention: it raises the pruning mark in agboss_cost_entries_pruned (never
-- lowers it) and deletes the entries made before it, in one statement. A save reads the mark FOR
-- SHARE in its own statement and refuses an entry made before it that the table does not hold
-- (it may have been counted and pruned since), so a retry is never counted twice.
--
-- An entry written before this migration has no date: it is dated 'infinity' — never pruned, never
-- refused (its pass's retry finds it held). Delete those rows by hand once no pass from before the
-- upgrade runs.
ALTER TABLE agboss_cost_entries ADD COLUMN made_at timestamptz;
UPDATE agboss_cost_entries SET made_at = 'infinity';
ALTER TABLE agboss_cost_entries ALTER COLUMN made_at SET NOT NULL;
CREATE INDEX agboss_cost_entries_made_at ON agboss_cost_entries (made_at);

CREATE TABLE agboss_cost_entries_pruned (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  pruned_before timestamptz NOT NULL
);
INSERT INTO agboss_cost_entries_pruned (id, pruned_before) VALUES (true, '-infinity');

COMMENT ON TABLE agboss_cost_entries IS
  'agbossjs/agboss#727, #771: one row per ledger entry (a tallied spend), by the ledgerId of the pass that made it, dated by its madeAt; pruned under agboss_cost_entries_pruned — a save of an entry made before the mark that is not held is refused';
