-- ExecutionRecordRepository (#261, #265 S30): threads with their owner, one record per execution
-- (ordered by seq, the order they were appended), scores, summaries, config snapshots and the
-- permanent log of resolved pauses (#267 S107).
CREATE TABLE agboss_threads (
  tenant_id text NOT NULL,
  id text NOT NULL,
  workflow text NOT NULL,
  owner text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE agboss_execution_records (
  seq bigserial NOT NULL UNIQUE,
  id text PRIMARY KEY,
  run_id text,
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  workflow text NOT NULL,
  created_at timestamptz NOT NULL,
  task text NOT NULL,
  reply_with text NOT NULL,
  status text NOT NULL,
  stop_reason text NOT NULL,
  route jsonb NOT NULL,
  steps jsonb NOT NULL,
  cost_usd double precision NOT NULL,
  prompt_version text NOT NULL,
  model_version text NOT NULL,
  replay_of text,
  config_version text,
  config_hash text,
  FOREIGN KEY (tenant_id, thread_id) REFERENCES agboss_threads (tenant_id, id)
);
CREATE INDEX agboss_execution_records_by_thread
  ON agboss_execution_records (tenant_id, thread_id, seq);
CREATE INDEX agboss_execution_records_by_version
  ON agboss_execution_records (workflow, prompt_version, seq);
CREATE INDEX agboss_execution_records_by_status ON agboss_execution_records (status, seq);

CREATE TABLE agboss_execution_scores (
  record_id text NOT NULL REFERENCES agboss_execution_records (id),
  judge text NOT NULL,
  score double precision NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX agboss_execution_scores_by_record ON agboss_execution_scores (record_id);

CREATE TABLE agboss_execution_summaries (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  workflow text NOT NULL,
  compaction text NOT NULL,
  from_record_id text NOT NULL,
  to_record_id text NOT NULL,
  from_seq bigint NOT NULL,
  to_seq bigint NOT NULL,
  turns integer NOT NULL,
  text text NOT NULL,
  cost_usd double precision NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, thread_id) REFERENCES agboss_threads (tenant_id, id)
);
CREATE INDEX agboss_execution_summaries_by_compaction
  ON agboss_execution_summaries (tenant_id, thread_id, compaction, to_seq);

CREATE TABLE agboss_config_versions (
  workflow text NOT NULL,
  version text NOT NULL,
  hash text NOT NULL,
  snapshot text NOT NULL,
  first_seen timestamptz NOT NULL,
  PRIMARY KEY (workflow, version, hash)
);

CREATE TABLE agboss_pause_answers (
  seq bigserial NOT NULL UNIQUE,
  tenant_id text NOT NULL,
  root_execution_id text NOT NULL,
  step_key text NOT NULL,
  asked_at text NOT NULL,
  record text NOT NULL,
  PRIMARY KEY (tenant_id, step_key)
);
CREATE INDEX agboss_pause_answers_by_root
  ON agboss_pause_answers (tenant_id, root_execution_id, asked_at, seq);
