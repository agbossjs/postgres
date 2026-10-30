-- ExecutionTreeRepository (#265): one row per key of a tree, its value as JSON.
CREATE TABLE agboss_execution_tree_keys (
  tenant_id text NOT NULL,
  root_execution_id text NOT NULL,
  tree_key text NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (tenant_id, root_execution_id, tree_key)
);
