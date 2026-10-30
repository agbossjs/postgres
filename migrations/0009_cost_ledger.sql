-- CostLedgerRepository (agbossjs/agboss#483): one counter per budget, scope, scope key and period
-- (empty for an execution budget), each call's cost added by an upsert of its row; the last
-- maxSpend() an execution read per budget, scope and scope key.
CREATE TABLE agboss_cost_counters (
  budget text NOT NULL,
  scope text NOT NULL,
  scope_key text NOT NULL,
  period text NOT NULL,
  spent_usd double precision NOT NULL,
  PRIMARY KEY (budget, scope, scope_key, period)
);

CREATE TABLE agboss_cost_max_spend (
  budget text NOT NULL,
  scope text NOT NULL,
  scope_key text NOT NULL,
  max_spend_usd double precision NOT NULL,
  PRIMARY KEY (budget, scope, scope_key)
);
