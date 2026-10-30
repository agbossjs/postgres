-- ExecutionHistoryRepository (agbossjs/agboss#483): one row per kept root execution, its record as
-- jsonb beside the columns it is found by. Ids are ordered byte-wise (COLLATE "C"), as SQLite
-- orders them, whatever the database's collation.
CREATE TABLE agboss_execution_history (
  tenant_id text NOT NULL,
  execution_id text NOT NULL,
  thread_id text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  record jsonb NOT NULL,
  PRIMARY KEY (tenant_id, execution_id)
);
-- `agboss records export --all-tenants`, and the tenant's export
CREATE INDEX agboss_execution_history_by_started_at
  ON agboss_execution_history (started_at, execution_id COLLATE "C");
CREATE INDEX agboss_execution_history_by_tenant_started_at
  ON agboss_execution_history (tenant_id, started_at, execution_id COLLATE "C");
CREATE INDEX agboss_execution_history_by_thread
  ON agboss_execution_history (tenant_id, thread_id, started_at);
CREATE INDEX agboss_execution_history_by_execution_id
  ON agboss_execution_history (execution_id);
-- the retention sweep: only ended records are removed
CREATE INDEX agboss_execution_history_by_ended_at
  ON agboss_execution_history (ended_at) WHERE ended_at IS NOT NULL;
