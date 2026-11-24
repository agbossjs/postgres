-- The 0.1.1 baseline schema (agbossjs/agboss#1321c): migrations 0001-0035 of 0.1.0 squashed into one
-- file, the shape they ended in. 0.1.0 has no users and no 0.1.0 database is migrated: this file
-- creates the whole schema on an empty one. Each store train that changes a table adds the next
-- numbered file (0002, 0003, ...), numbered when the train is cut; none is reserved ahead.
-- Every statement is IF NOT EXISTS, so it is written to rerun. Run once no instance of an earlier
-- version runs (ADR-0034).

CREATE TABLE IF NOT EXISTS agboss_a2a_direct_messages (
    endpoint text NOT NULL,
    tenant_id text NOT NULL,
    owner_id text NOT NULL,
    message_id text NOT NULL,
    request_hash text NOT NULL,
    skill text NOT NULL,
    context_id text NOT NULL,
    state text NOT NULL,
    attempt_id text NOT NULL COLLATE pg_catalog."C",
    calls_model boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    caller_peer text,
    mesh_body_hash text,
    reply jsonb,
    completed_at timestamp with time zone,
    CONSTRAINT agboss_a2a_direct_messages_reply_check CHECK ((((reply IS NULL) = (completed_at IS NULL)) AND ((state = 'completed'::text) = (reply IS NOT NULL)))),
    CONSTRAINT agboss_a2a_direct_messages_state_check CHECK ((state = ANY (ARRAY['in-flight'::text, 'completed'::text]))),
    CONSTRAINT agboss_a2a_direct_messages_pkey PRIMARY KEY (tenant_id, owner_id, message_id)
);
CREATE INDEX IF NOT EXISTS agboss_a2a_direct_messages_by_endpoint ON agboss_a2a_direct_messages (endpoint, completed_at);
CREATE INDEX IF NOT EXISTS agboss_a2a_direct_messages_in_flight ON agboss_a2a_direct_messages (expires_at) WHERE (state = 'in-flight'::text);

CREATE TABLE IF NOT EXISTS agboss_a2a_messages (
    endpoint text NOT NULL,
    tenant_id text NOT NULL,
    owner_id text NOT NULL,
    message_id text NOT NULL,
    request_hash text NOT NULL,
    task_id text NOT NULL COLLATE pg_catalog."C",
    saved_at timestamp with time zone NOT NULL,
    reply jsonb,
    CONSTRAINT agboss_a2a_messages_pkey PRIMARY KEY (tenant_id, owner_id, message_id)
);
CREATE INDEX IF NOT EXISTS agboss_a2a_messages_by_task ON agboss_a2a_messages (tenant_id, task_id);
CREATE INDEX IF NOT EXISTS agboss_a2a_messages_by_endpoint ON agboss_a2a_messages (endpoint, task_id, saved_at);

CREATE TABLE IF NOT EXISTS agboss_a2a_tasks (
    endpoint text NOT NULL,
    tenant_id text NOT NULL,
    task_id text NOT NULL COLLATE pg_catalog."C",
    owner_id text NOT NULL,
    context_id text NOT NULL,
    skill text NOT NULL,
    state text NOT NULL,
    status jsonb NOT NULL,
    version integer NOT NULL,
    accepted_at timestamp with time zone NOT NULL,
    status_at timestamp with time zone NOT NULL,
    caller_peer text,
    mesh_body_hash text,
    CONSTRAINT agboss_a2a_tasks_pkey PRIMARY KEY (tenant_id, task_id)
);
CREATE INDEX IF NOT EXISTS agboss_a2a_tasks_by_owner ON agboss_a2a_tasks (tenant_id, owner_id, status_at DESC, task_id DESC);
CREATE INDEX IF NOT EXISTS agboss_a2a_tasks_by_endpoint ON agboss_a2a_tasks (endpoint, state, status_at);

CREATE TABLE IF NOT EXISTS agboss_child_execution_queue (
    tenant_id text NOT NULL,
    execution_id text NOT NULL,
    root_execution_id text NOT NULL,
    parent_execution_id text NOT NULL,
    root_workflow text NOT NULL,
    workflow text NOT NULL,
    depth integer NOT NULL,
    status text NOT NULL,
    run text NOT NULL,
    queued_at timestamp with time zone NOT NULL,
    instance_id text,
    claimed_at timestamp with time zone,
    ended_at timestamp with time zone,
    failure text,
    placement text,
    exclude_instance_id text,
    CONSTRAINT agboss_child_execution_queue_pkey PRIMARY KEY (tenant_id, execution_id)
);
CREATE INDEX IF NOT EXISTS agboss_child_execution_queue_by_root ON agboss_child_execution_queue (tenant_id, root_execution_id);
CREATE INDEX IF NOT EXISTS agboss_child_execution_queue_claims ON agboss_child_execution_queue (status, depth DESC, queued_at);

CREATE TABLE IF NOT EXISTS agboss_config_versions (
    workflow text NOT NULL,
    version text NOT NULL,
    hash text NOT NULL,
    snapshot text NOT NULL,
    first_seen timestamp with time zone NOT NULL,
    CONSTRAINT agboss_config_versions_pkey PRIMARY KEY (workflow, version, hash)
);

CREATE TABLE IF NOT EXISTS agboss_cost_counters (
    budget text NOT NULL,
    scope text NOT NULL,
    scope_key text NOT NULL,
    period text NOT NULL,
    spent_usd double precision NOT NULL,
    tokens bigint DEFAULT 0 NOT NULL,
    CONSTRAINT agboss_cost_counters_pkey PRIMARY KEY (budget, scope, scope_key, period)
);

CREATE TABLE IF NOT EXISTS agboss_cost_entries (
    ledger_id text NOT NULL,
    made_at timestamp with time zone NOT NULL,
    CONSTRAINT agboss_cost_entries_pkey PRIMARY KEY (ledger_id)
);
CREATE INDEX IF NOT EXISTS agboss_cost_entries_made_at ON agboss_cost_entries (made_at);
COMMENT ON TABLE agboss_cost_entries IS 'agbossjs/agboss#727, #771: one row per ledger entry (a tallied spend), by the ledgerId of the pass that made it, dated by its madeAt; pruned under agboss_cost_entries_pruned — a save of an entry made before the mark that is not held is refused';

CREATE TABLE IF NOT EXISTS agboss_cost_entries_pruned (
    id boolean DEFAULT true NOT NULL,
    pruned_before timestamp with time zone NOT NULL,
    CONSTRAINT agboss_cost_entries_pruned_id_check CHECK (id),
    CONSTRAINT agboss_cost_entries_pruned_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS agboss_cost_max_spend (
    budget text NOT NULL,
    scope text NOT NULL,
    scope_key text NOT NULL,
    max_spend_usd double precision,
    max_tokens bigint,
    CONSTRAINT agboss_cost_max_spend_pkey PRIMARY KEY (budget, scope, scope_key)
);

CREATE TABLE IF NOT EXISTS agboss_execution_history (
    tenant_id text NOT NULL,
    execution_id text NOT NULL,
    thread_id text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    record jsonb NOT NULL,
    CONSTRAINT agboss_execution_history_pkey PRIMARY KEY (tenant_id, execution_id)
);
CREATE INDEX IF NOT EXISTS agboss_execution_history_by_ended_at ON agboss_execution_history (ended_at) WHERE (ended_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS agboss_execution_history_by_execution_id ON agboss_execution_history (execution_id);
CREATE INDEX IF NOT EXISTS agboss_execution_history_by_started_at ON agboss_execution_history (started_at, execution_id COLLATE "C");
CREATE INDEX IF NOT EXISTS agboss_execution_history_by_tenant_started_at ON agboss_execution_history (tenant_id, started_at, execution_id COLLATE "C");
CREATE INDEX IF NOT EXISTS agboss_execution_history_by_thread ON agboss_execution_history (tenant_id, thread_id, started_at);

CREATE TABLE IF NOT EXISTS agboss_execution_ids (
    execution_id text NOT NULL COLLATE pg_catalog."C",
    tenant_id text NOT NULL,
    CONSTRAINT agboss_execution_ids_pkey PRIMARY KEY (execution_id)
);

CREATE TABLE IF NOT EXISTS agboss_execution_lease_events (
    id bigint GENERATED ALWAYS AS IDENTITY,
    tenant_id text NOT NULL,
    root_execution_id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT agboss_execution_lease_events_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS agboss_execution_lease_events_by_occurred_at ON agboss_execution_lease_events (occurred_at);
CREATE INDEX IF NOT EXISTS agboss_execution_lease_events_by_tree ON agboss_execution_lease_events (tenant_id, root_execution_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS agboss_execution_leases (
    tenant_id text NOT NULL,
    root_execution_id text NOT NULL,
    holder_instance_id text NOT NULL,
    token integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    released boolean NOT NULL,
    yielded boolean DEFAULT false NOT NULL,
    superseded boolean DEFAULT false NOT NULL,
    finished boolean DEFAULT false NOT NULL,
    cancel_requested_at timestamp with time zone,
    stop_requested_at timestamp with time zone,
    stop_mode text,
    is_externally_paused boolean DEFAULT false NOT NULL,
    external_pause_reason text,
    external_pause_mode text,
    fenced_through_token integer,
    CONSTRAINT agboss_execution_leases_token_check CHECK ((token >= 0)),
    CONSTRAINT agboss_execution_leases_stop_mode_check CHECK ((stop_mode IS NULL OR stop_mode = ANY (ARRAY['after-step'::text, 'immediate'::text]))),
    CONSTRAINT agboss_execution_leases_pause_mode_check CHECK ((external_pause_mode IS NULL OR external_pause_mode = ANY (ARRAY['after-step'::text, 'immediate'::text]))),
    CONSTRAINT agboss_execution_leases_pkey PRIMARY KEY (tenant_id, root_execution_id)
);

-- #1341d: the status history of a thread, one row per change, written in the transaction of the
-- change (a lease's mark, a record's status write). `seq` is 1 for the thread's first change.
CREATE TABLE IF NOT EXISTS agboss_thread_status_transitions (
    tenant_id text NOT NULL,
    thread_id text NOT NULL,
    seq integer NOT NULL,
    from_status text,
    to_status text NOT NULL,
    trigger text NOT NULL,
    reason text,
    actor text,
    lease_token integer,
    at timestamp with time zone NOT NULL,
    CONSTRAINT agboss_thread_status_transitions_pkey PRIMARY KEY (tenant_id, thread_id, seq)
);

CREATE TABLE IF NOT EXISTS agboss_execution_tree_keys (
    tenant_id text NOT NULL,
    root_execution_id text NOT NULL,
    tree_key text NOT NULL,
    value jsonb NOT NULL,
    CONSTRAINT agboss_execution_tree_keys_pkey PRIMARY KEY (tenant_id, root_execution_id, tree_key)
);

CREATE TABLE IF NOT EXISTS agboss_fenced_effect_business_results (
    tenant_id text NOT NULL,
    name text NOT NULL,
    business_key text NOT NULL,
    token integer NOT NULL,
    stored_at timestamp with time zone NOT NULL,
    result text NOT NULL,
    fingerprint text,
    origin jsonb,
    expires_at timestamp with time zone,
    CONSTRAINT agboss_fenced_effect_business_results_pkey PRIMARY KEY (tenant_id, name, business_key)
);
CREATE INDEX IF NOT EXISTS agboss_fenced_effect_business_results_by_expiry ON agboss_fenced_effect_business_results (expires_at) WHERE (expires_at IS NOT NULL);

CREATE TABLE IF NOT EXISTS agboss_fenced_effect_marks (
    scope_key text NOT NULL,
    highest_token integer NOT NULL,
    stored_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT agboss_fenced_effect_marks_pkey PRIMARY KEY (scope_key)
);
CREATE INDEX IF NOT EXISTS agboss_fenced_effect_marks_by_expiry ON agboss_fenced_effect_marks (expires_at) WHERE (expires_at IS NOT NULL);

CREATE TABLE IF NOT EXISTS agboss_fenced_effect_results (
    scope_key text NOT NULL,
    idempotency_key text NOT NULL,
    name text NOT NULL,
    token integer NOT NULL,
    stored_at timestamp with time zone NOT NULL,
    result text NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT agboss_fenced_effect_results_pkey PRIMARY KEY (scope_key, idempotency_key, name)
);
CREATE INDEX IF NOT EXISTS agboss_fenced_effect_results_by_expiry ON agboss_fenced_effect_results (expires_at) WHERE (expires_at IS NOT NULL);

CREATE TABLE IF NOT EXISTS agboss_mesh_requests (
    tenant_id text NOT NULL,
    peer text NOT NULL,
    idempotency_key text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    response jsonb,
    CONSTRAINT agboss_mesh_requests_pkey PRIMARY KEY (tenant_id, peer, idempotency_key)
);
CREATE INDEX IF NOT EXISTS agboss_mesh_requests_by_created_at ON agboss_mesh_requests (created_at);

CREATE TABLE IF NOT EXISTS agboss_outbound_calls (
    id bigint GENERATED ALWAYS AS IDENTITY,
    scope_key text NOT NULL,
    idempotency_key text NOT NULL,
    name text NOT NULL,
    tenant_id text NOT NULL,
    root_execution_id text NOT NULL,
    business_key text,
    status text NOT NULL,
    attempt integer NOT NULL,
    attempt_owner text NOT NULL,
    expires_at timestamp with time zone,
    record jsonb NOT NULL,
    CONSTRAINT agboss_outbound_calls_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agboss_outbound_calls_by_business_key ON agboss_outbound_calls (tenant_id, name, business_key) WHERE (business_key IS NOT NULL);
CREATE INDEX IF NOT EXISTS agboss_outbound_calls_by_expiry ON agboss_outbound_calls (expires_at) WHERE (expires_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS agboss_outbound_calls_by_status ON agboss_outbound_calls (tenant_id, status, id);
CREATE UNIQUE INDEX IF NOT EXISTS agboss_outbound_calls_by_step ON agboss_outbound_calls (scope_key, idempotency_key, name) WHERE (business_key IS NULL);
CREATE INDEX IF NOT EXISTS agboss_outbound_calls_by_tree ON agboss_outbound_calls (tenant_id, root_execution_id, id);

CREATE TABLE IF NOT EXISTS agboss_pause_answers (
    seq bigserial,
    tenant_id text NOT NULL,
    root_execution_id text NOT NULL,
    step_key text NOT NULL,
    asked_at text NOT NULL,
    record text NOT NULL,
    CONSTRAINT agboss_pause_answers_pkey PRIMARY KEY (tenant_id, root_execution_id, step_key),
    CONSTRAINT agboss_pause_answers_seq_key UNIQUE (seq)
);
CREATE INDEX IF NOT EXISTS agboss_pause_answers_by_root ON agboss_pause_answers (tenant_id, root_execution_id, asked_at, seq);

CREATE TABLE IF NOT EXISTS agboss_pause_notices (
    tenant_id text NOT NULL,
    pause_id text NOT NULL,
    recipient text NOT NULL,
    notices jsonb NOT NULL,
    delivered integer NOT NULL,
    attempts integer NOT NULL,
    next_attempt_at timestamp with time zone NOT NULL,
    head_written_at timestamp with time zone,
    is_dead boolean NOT NULL,
    problem text,
    claim_token text,
    claimed_until timestamp with time zone,
    CONSTRAINT agboss_pause_notices_pkey PRIMARY KEY (tenant_id, pause_id, recipient)
);
CREATE INDEX IF NOT EXISTS agboss_pause_notices_due ON agboss_pause_notices (next_attempt_at) WHERE (NOT is_dead);
CREATE INDEX IF NOT EXISTS agboss_pause_notices_stale ON agboss_pause_notices (head_written_at) WHERE (NOT is_dead);

CREATE TABLE IF NOT EXISTS agboss_paused_executions (
    tenant_id text NOT NULL,
    thread_id text NOT NULL,
    run_id text NOT NULL,
    run text NOT NULL,
    workflow_version text NOT NULL,
    config_hash text NOT NULL,
    paused_at timestamp with time zone NOT NULL,
    CONSTRAINT agboss_paused_executions_pkey PRIMARY KEY (tenant_id, thread_id)
);

CREATE TABLE IF NOT EXISTS agboss_pauses (
    seq bigserial,
    tenant_id text NOT NULL,
    pause_id text NOT NULL,
    step_key text NOT NULL,
    root_execution_id text NOT NULL,
    status text NOT NULL,
    resolved_at timestamp with time zone,
    record jsonb NOT NULL,
    expires_at timestamp with time zone,
    remind_at timestamp with time zone,
    channel text GENERATED ALWAYS AS ((record ->> 'channel'::text)) STORED,
    CONSTRAINT agboss_pauses_pkey PRIMARY KEY (tenant_id, pause_id),
    CONSTRAINT agboss_pauses_seq_key UNIQUE (seq),
    CONSTRAINT agboss_pauses_tenant_id_root_execution_id_step_key_key UNIQUE (tenant_id, root_execution_id, step_key)
);
CREATE INDEX IF NOT EXISTS agboss_pauses_by_resolved_at ON agboss_pauses (status, resolved_at);
CREATE INDEX IF NOT EXISTS agboss_pauses_by_root ON agboss_pauses (tenant_id, root_execution_id, seq);
CREATE INDEX IF NOT EXISTS agboss_pauses_by_tenant ON agboss_pauses (tenant_id, status, channel, seq);
CREATE INDEX IF NOT EXISTS agboss_pauses_open ON agboss_pauses (seq) WHERE (status = ANY (ARRAY['pending'::text, 'resolved'::text]));
CREATE INDEX IF NOT EXISTS agboss_pauses_pending_by_expiry ON agboss_pauses (expires_at) WHERE ((status = 'pending'::text) AND (expires_at IS NOT NULL));
CREATE INDEX IF NOT EXISTS agboss_pauses_pending_by_reminder ON agboss_pauses (remind_at) WHERE ((status = 'pending'::text) AND (remind_at IS NOT NULL));
CREATE INDEX IF NOT EXISTS agboss_pauses_reassigned_unsent ON agboss_pauses (((record ->> 'askedAt'::text)) COLLATE "C", tenant_id COLLATE "C", pause_id COLLATE "C") WHERE ((status = 'pending'::text) AND (record ? 'reassignedFrom'::text) AND ((record ->> 'isSent'::text) = 'false'::text));

CREATE TABLE IF NOT EXISTS agboss_rate_limit_keys (
    limit_key text NOT NULL,
    CONSTRAINT agboss_rate_limit_keys_pkey PRIMARY KEY (limit_key)
);

CREATE TABLE IF NOT EXISTS agboss_rate_limit_pauses (
    pause_key text NOT NULL,
    paused_until timestamp with time zone NOT NULL,
    CONSTRAINT agboss_rate_limit_pauses_pkey PRIMARY KEY (pause_key)
);

CREATE TABLE IF NOT EXISTS agboss_rate_limit_slots (
    slot_id text NOT NULL,
    slot_key text NOT NULL,
    holder_instance_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT agboss_rate_limit_slots_pkey PRIMARY KEY (slot_id)
);
CREATE INDEX IF NOT EXISTS agboss_rate_limit_slots_by_key ON agboss_rate_limit_slots (slot_key, expires_at);

CREATE TABLE IF NOT EXISTS agboss_rate_limit_window_buckets (
    window_key text NOT NULL,
    counted_at timestamp with time zone NOT NULL,
    amount double precision NOT NULL,
    CONSTRAINT agboss_rate_limit_window_buckets_pkey PRIMARY KEY (window_key, counted_at)
);

CREATE TABLE IF NOT EXISTS agboss_threads (
    tenant_id text NOT NULL,
    id text NOT NULL,
    workflow text NOT NULL,
    owner text,
    created_at timestamp with time zone NOT NULL,
    last_active_at timestamp with time zone NOT NULL,
    is_swept boolean DEFAULT false NOT NULL,
    CONSTRAINT agboss_threads_pkey PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS agboss_threads_idle ON agboss_threads (workflow, last_active_at) WHERE (NOT is_swept);

CREATE TABLE IF NOT EXISTS agboss_execution_records (
    seq bigserial,
    id text NOT NULL,
    run_id text,
    tenant_id text NOT NULL,
    thread_id text NOT NULL,
    workflow text NOT NULL,
    created_at timestamp with time zone NOT NULL,
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
    CONSTRAINT agboss_execution_records_pkey PRIMARY KEY (id),
    CONSTRAINT agboss_execution_records_seq_key UNIQUE (seq),
    CONSTRAINT agboss_execution_records_tenant_id_thread_id_fkey FOREIGN KEY (tenant_id, thread_id) REFERENCES agboss_threads(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS agboss_execution_records_by_run ON agboss_execution_records (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS agboss_execution_records_by_status ON agboss_execution_records (status, seq);
CREATE INDEX IF NOT EXISTS agboss_execution_records_by_thread ON agboss_execution_records (tenant_id, thread_id, seq);
CREATE INDEX IF NOT EXISTS agboss_execution_records_by_version ON agboss_execution_records (workflow, prompt_version, seq);

CREATE TABLE IF NOT EXISTS agboss_execution_scores (
    record_id text NOT NULL,
    judge text NOT NULL,
    score double precision NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT agboss_execution_scores_record_id_fkey FOREIGN KEY (record_id) REFERENCES agboss_execution_records(id)
);
CREATE INDEX IF NOT EXISTS agboss_execution_scores_by_record ON agboss_execution_scores (record_id);

CREATE TABLE IF NOT EXISTS agboss_execution_summaries (
    id text NOT NULL,
    tenant_id text NOT NULL,
    thread_id text NOT NULL,
    workflow text NOT NULL,
    memory text NOT NULL,
    from_record_id text NOT NULL,
    to_record_id text NOT NULL,
    from_seq bigint NOT NULL,
    to_seq bigint NOT NULL,
    turns integer NOT NULL,
    text text NOT NULL,
    cost_usd double precision NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT agboss_execution_summaries_pkey PRIMARY KEY (id),
    CONSTRAINT agboss_execution_summaries_tenant_id_thread_id_fkey FOREIGN KEY (tenant_id, thread_id) REFERENCES agboss_threads(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS agboss_execution_summaries_by_memory ON agboss_execution_summaries (tenant_id, thread_id, memory, to_seq);

-- the pruning mark's seed row: `-infinity` means nothing has been pruned yet. A save reads this row
-- FOR SHARE: without it a save finds no mark. Rerunnable.
INSERT INTO agboss_cost_entries_pruned (id, pruned_before) VALUES (true, '-infinity') ON CONFLICT (id) DO NOTHING;
