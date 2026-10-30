-- ExecutionLeaseEventRepository (#501): the append-only lease log — one row per takeover,
-- hand-over or fenced effect call, its record as JSON beside the columns it is found by. `id`
-- keeps the order rows were saved in, so rows of one moment come back in that order.
CREATE TABLE agboss_execution_lease_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  root_execution_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX agboss_execution_lease_events_by_tree
  ON agboss_execution_lease_events (tenant_id, root_execution_id, occurred_at, id);
CREATE INDEX agboss_execution_lease_events_by_occurred_at
  ON agboss_execution_lease_events (occurred_at);
