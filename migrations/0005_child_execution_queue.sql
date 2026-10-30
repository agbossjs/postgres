-- ChildExecutionQueueRepository (#333 PR 2): one row per child launched with
-- ChildPlacement.AnyInstance; a claim takes the deepest, then the longest waiting, queued row
-- with FOR UPDATE SKIP LOCKED.
CREATE TABLE agboss_child_execution_queue (
  tenant_id text NOT NULL,
  execution_id text NOT NULL,
  root_execution_id text NOT NULL,
  parent_execution_id text NOT NULL,
  root_workflow text NOT NULL,
  workflow text NOT NULL,
  depth integer NOT NULL,
  status text NOT NULL,
  run text NOT NULL,
  queued_at timestamptz NOT NULL,
  instance_id text,
  claimed_at timestamptz,
  ended_at timestamptz,
  failure text,
  PRIMARY KEY (tenant_id, execution_id)
);
CREATE INDEX agboss_child_execution_queue_claims
  ON agboss_child_execution_queue (status, depth DESC, queued_at);
CREATE INDEX agboss_child_execution_queue_by_root
  ON agboss_child_execution_queue (tenant_id, root_execution_id);
