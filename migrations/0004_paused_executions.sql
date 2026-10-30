-- PausedExecutionRepository (#265, #267 S35): the paused run of a thread, and one row per pause —
-- unique per step key of a tenant; its status and resolution time are columns of their own, so a
-- transition is one compare-and-set UPDATE … WHERE status = 'pending'.
CREATE TABLE agboss_paused_executions (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  run text NOT NULL,
  workflow_version text NOT NULL,
  config_hash text NOT NULL,
  paused_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, thread_id)
);

CREATE TABLE agboss_pauses (
  seq bigserial NOT NULL UNIQUE,
  tenant_id text NOT NULL,
  pause_id text NOT NULL,
  step_key text NOT NULL,
  root_execution_id text NOT NULL,
  status text NOT NULL,
  resolved_at timestamptz,
  record jsonb NOT NULL,
  PRIMARY KEY (tenant_id, pause_id),
  UNIQUE (tenant_id, step_key)
);
CREATE INDEX agboss_pauses_by_root ON agboss_pauses (tenant_id, root_execution_id, seq);
CREATE INDEX agboss_pauses_by_resolved_at ON agboss_pauses (status, resolved_at);
