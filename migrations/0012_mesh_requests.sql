-- MeshRequestRepository (agbossjs/agboss#483): one row per trusted mesh request, by the receiver's
-- tenant, the peer and the caller's idempotency key; its answer as jsonb once it has one (NULL
-- while it runs).
CREATE TABLE agboss_mesh_requests (
  tenant_id text NOT NULL,
  peer text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  response jsonb,
  PRIMARY KEY (tenant_id, peer, idempotency_key)
);
-- the retention sweep
CREATE INDEX agboss_mesh_requests_by_created_at ON agboss_mesh_requests (created_at);
