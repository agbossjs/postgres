-- FencedEffectRepository (#500): each lease scope's high-water mark and each effect's result,
-- beside agboss_execution_leases, whose row the effect's transaction locks first.
CREATE TABLE agboss_fenced_effect_marks (
  scope_key text PRIMARY KEY,
  highest_token integer NOT NULL,
  stored_at timestamptz NOT NULL
);
CREATE INDEX agboss_fenced_effect_marks_by_stored_at ON agboss_fenced_effect_marks (stored_at);

CREATE TABLE agboss_fenced_effect_results (
  scope_key text NOT NULL,
  idempotency_key text NOT NULL,
  name text NOT NULL,
  token integer NOT NULL,
  stored_at timestamptz NOT NULL,
  result text NOT NULL,
  PRIMARY KEY (scope_key, idempotency_key, name)
);
CREATE INDEX agboss_fenced_effect_results_by_stored_at ON agboss_fenced_effect_results (stored_at);
