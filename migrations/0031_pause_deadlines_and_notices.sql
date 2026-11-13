-- The pause store, contract v2 (agbossjs/agboss#936, #910): a pause's deadline, reminder and
-- channel as columns of their own (each is mirrored in `record`, which stays the one source of a
-- pause's fields: a read never needs the columns), and the notices of a pause — one ordered
-- mailbox per pause and receiver, written in the transaction of the change that causes them.
-- Only adds: no row's `record` is rewritten; no pause before this one has a deadline.
ALTER TABLE agboss_pauses
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN remind_at timestamptz,
  ADD COLUMN channel text;

UPDATE agboss_pauses SET channel = record->>'channel' WHERE channel IS NULL;

-- the sweep's and the reminder's looks read pending pauses only
CREATE INDEX agboss_pauses_pending_by_expiry ON agboss_pauses (expires_at)
  WHERE status = 'pending' AND expires_at IS NOT NULL;
CREATE INDEX agboss_pauses_pending_by_reminder ON agboss_pauses (remind_at)
  WHERE status = 'pending' AND remind_at IS NOT NULL;
-- a tenant's pages follow `seq`, the monotonic insertion sequence (never a reusable id)
CREATE INDEX agboss_pauses_by_tenant ON agboss_pauses (tenant_id, status, channel, seq);
CREATE INDEX agboss_pauses_open ON agboss_pauses (seq) WHERE status IN ('pending', 'resolved');

CREATE TABLE agboss_pause_notices (
  tenant_id text NOT NULL,
  pause_id text NOT NULL,
  recipient text NOT NULL,
  notices jsonb NOT NULL,
  delivered integer NOT NULL,
  attempts integer NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  head_written_at timestamptz,
  is_dead boolean NOT NULL,
  problem text,
  claim_token text,
  claimed_until timestamptz,
  PRIMARY KEY (tenant_id, pause_id, recipient)
);
CREATE INDEX agboss_pause_notices_due ON agboss_pause_notices (next_attempt_at) WHERE NOT is_dead;
CREATE INDEX agboss_pause_notices_stale ON agboss_pause_notices (head_written_at) WHERE NOT is_dead;
