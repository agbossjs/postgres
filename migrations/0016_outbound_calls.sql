-- OutboundCallRepository (agbossjs/agboss#505, #508): one intent per call that leaves the system —
-- by its step (scope, idempotency key, name) or, with a business key, by its tenant, name and key.
-- `record` is the record as the framework reads it; the columns beside it are what the statements
-- match and order by: `status`, `attempt` and `attempt_owner` are the compare-and-set of a new
-- attempt or an ending, `ended_at` the retention cutoff (NULL while pending), `id` the order
-- recorded.
CREATE TABLE agboss_outbound_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_key text NOT NULL,
  idempotency_key text NOT NULL,
  name text NOT NULL,
  tenant_id text NOT NULL,
  root_execution_id text NOT NULL,
  business_key text,
  status text NOT NULL,
  attempt integer NOT NULL,
  attempt_owner text NOT NULL,
  ended_at timestamptz,
  record jsonb NOT NULL
);
CREATE UNIQUE INDEX agboss_outbound_calls_by_step
  ON agboss_outbound_calls (scope_key, idempotency_key, name) WHERE business_key IS NULL;
CREATE UNIQUE INDEX agboss_outbound_calls_by_business_key
  ON agboss_outbound_calls (tenant_id, name, business_key) WHERE business_key IS NOT NULL;
CREATE INDEX agboss_outbound_calls_by_tree
  ON agboss_outbound_calls (tenant_id, root_execution_id, id);
CREATE INDEX agboss_outbound_calls_by_status ON agboss_outbound_calls (tenant_id, status, id);
CREATE INDEX agboss_outbound_calls_by_ended_at
  ON agboss_outbound_calls (ended_at) WHERE ended_at IS NOT NULL;
