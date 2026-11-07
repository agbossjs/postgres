-- agbossjs/agboss#810: an A2A task keeps the bodyHash of the message that started it, only when the
-- envelope was signed by the mesh peer the caller resolver authenticated: what the run report its
-- completed task gets binds. A nullable column: a task saved before has none, and reads as untrusted
-- (no report; its caller is charged the contract price). Its status's mesh facts (`errorDetails`,
-- `spentUsd`) are in the status's jsonb already. Adding a nullable column without a default changes
-- no row: safe to run while any version runs.
ALTER TABLE agboss_a2a_tasks ADD COLUMN IF NOT EXISTS mesh_body_hash text;
