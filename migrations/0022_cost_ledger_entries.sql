-- agbossjs/agboss#727: spend is written to the ledger the moment it is made, each record under its
-- ledgerId (the step's key, its call, its caller, its number there). A step run again after a crash
-- or a takeover saves its spend again under the same ids: the ledger adds an entry once — its id
-- inserted here in the statement that adds its cost to the counters.
CREATE TABLE agboss_cost_entries (
  ledger_id text PRIMARY KEY
);
