-- A2ADirectMessageRepository (agbossjs/agboss#860): the short-lived replies of the skills that
-- answer with a direct Message, shared by the instances. One row per accepted message, by tenant,
-- owner ('' for none) and message id — the key of agboss_a2a_messages, in its collation, so the
-- two tables join on it. A message's id is claimed in agboss_a2a_messages (a claim of no task:
-- task_id '') in the same transaction as its row here, so a task message and a direct message of
-- one id are never both kept. The reply is the store's NUL-escaped JSON (jsonb); its state agrees
-- with it, checked here too.
CREATE TABLE IF NOT EXISTS agboss_a2a_direct_messages (
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  message_id text NOT NULL,
  request_hash text NOT NULL,
  skill text NOT NULL,
  context_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('in-flight', 'completed')),
  attempt_id text COLLATE "C" NOT NULL,
  calls_model boolean NOT NULL,
  created_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  caller_peer text,
  mesh_body_hash text,
  reply jsonb,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, owner_id, message_id),
  CONSTRAINT agboss_a2a_direct_messages_reply_check
    CHECK ((reply IS NULL) = (completed_at IS NULL) AND (state = 'completed') = (reply IS NOT NULL))
);
-- the sweep of lost attempts: the messages in flight by their expiry
CREATE INDEX IF NOT EXISTS agboss_a2a_direct_messages_in_flight
  ON agboss_a2a_direct_messages (expires_at) WHERE state = 'in-flight';
-- the retention sweep: the messages by when they were accepted
CREATE INDEX IF NOT EXISTS agboss_a2a_direct_messages_by_age
  ON agboss_a2a_direct_messages (created_at);
-- the retention sweep frees the ids the direct messages claimed, by when they were claimed. Built
-- in the migration's transaction, it holds writes to agboss_a2a_messages (rows of the tasks'
-- retention only) while it builds; the new table changes no row of an older version.
CREATE INDEX IF NOT EXISTS agboss_a2a_messages_direct_claims
  ON agboss_a2a_messages (saved_at) WHERE task_id = '';
