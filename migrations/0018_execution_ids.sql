-- ExecutionLeaseRepository.saveExecutionIdIfAbsent (agbossjs/agboss#591): every execution id the
-- framework hands out — a root's, a child's, a recursion level's — kept once, by the id alone
-- (across tenants: a step's idempotency key and the key an outbound call sends with no business key
-- carry no tenant), and never removed, so no IdGenerator can give a new tree an older one's lease,
-- fencing token, lease log or step keys. `COLLATE "C"`: ids compare by their bytes, whatever the
-- database's default collation. The ids of the trees already here come from their leases (roots
-- and AnyInstance children; a ParentInstance child of before has no row of its own anywhere).
CREATE TABLE agboss_execution_ids (
  execution_id text COLLATE "C" PRIMARY KEY,
  tenant_id text NOT NULL
);

INSERT INTO agboss_execution_ids (execution_id, tenant_id)
  SELECT root_execution_id, tenant_id FROM agboss_execution_leases
  ON CONFLICT (execution_id) DO NOTHING;
