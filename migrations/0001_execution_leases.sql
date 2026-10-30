-- ExecutionLeaseRepository (#265): one row per tree with its latest lease, a released one kept
-- for its epoch. Times are the framework Clock's, never the database's.
CREATE TABLE agboss_execution_leases (
  tenant_id text NOT NULL,
  root_execution_id text NOT NULL,
  holder_instance_id text NOT NULL,
  lease_epoch integer NOT NULL CHECK (lease_epoch >= 1),
  expires_at timestamptz NOT NULL,
  released boolean NOT NULL,
  PRIMARY KEY (tenant_id, root_execution_id)
);
