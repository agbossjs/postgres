-- A2ATaskRepository (agbossjs/agboss#824): the A2A tasks an application serves, shared by its
-- instances. One row per task, by tenant and task id (its root execution's reserved id); one row per
-- accepted message, initial or follow-up, unique per tenant, owner ('' for none) and message id — a
-- message resent to any instance finds the task it was accepted for. Ids compare byte-wise
-- (COLLATE "C"), as the core's stores order them. New tables only: safe to run while any version runs.
CREATE TABLE IF NOT EXISTS agboss_a2a_tasks (
  tenant_id text NOT NULL,
  task_id text COLLATE "C" NOT NULL,
  owner_id text NOT NULL,
  context_id text NOT NULL,
  skill text NOT NULL,
  state text NOT NULL,
  status jsonb NOT NULL,
  version integer NOT NULL,
  accepted_at timestamptz NOT NULL,
  status_at timestamptz NOT NULL,
  caller_peer text,
  PRIMARY KEY (tenant_id, task_id)
);
-- ListTasks: a caller's tasks, newest status first
CREATE INDEX IF NOT EXISTS agboss_a2a_tasks_by_owner
  ON agboss_a2a_tasks (tenant_id, owner_id, status_at DESC, task_id DESC);
-- the retention sweep: finished tasks by their status time
CREATE INDEX IF NOT EXISTS agboss_a2a_tasks_finished
  ON agboss_a2a_tasks (status_at)
  WHERE state IN ('TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED',
                  'TASK_STATE_REJECTED');
CREATE TABLE IF NOT EXISTS agboss_a2a_messages (
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  message_id text NOT NULL,
  request_hash text NOT NULL,
  task_id text COLLATE "C" NOT NULL,
  saved_at timestamptz NOT NULL,
  reply jsonb,
  PRIMARY KEY (tenant_id, owner_id, message_id)
);
-- the sweep removes a finished task's messages with it
CREATE INDEX IF NOT EXISTS agboss_a2a_messages_by_task ON agboss_a2a_messages (tenant_id, task_id);
