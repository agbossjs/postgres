-- FencedEffectRepository business keys (agbossjs/agboss#508): an effect made under a business key is
-- one per tenant, name and key, whatever scope or step writes it — with the fingerprint of what it
-- does (another one is IdempotencyKeyConflictError) and the step that wrote it (`replayedFrom`).
CREATE TABLE agboss_fenced_effect_business_results (
  tenant_id text NOT NULL,
  name text NOT NULL,
  business_key text NOT NULL,
  token integer NOT NULL,
  stored_at timestamptz NOT NULL,
  result text NOT NULL,
  fingerprint text,
  origin jsonb,
  PRIMARY KEY (tenant_id, name, business_key)
);
CREATE INDEX agboss_fenced_effect_business_results_by_stored_at
  ON agboss_fenced_effect_business_results (stored_at);
