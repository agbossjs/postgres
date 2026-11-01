-- agbossjs/agboss#638: the ids 0018 kept from before came from the leases only — roots and
-- AnyInstance children. A ParentInstance child of before has no lease row, but every call it made
-- through OutboundCalls is a row here naming it (record.executionId), and its step-keyed key
-- (`<executionId>:<node>:<visit>:<name>`: no tenant, no scope) has reached the other system, which
-- would answer a new execution of that id with the old call's response. Every execution that made
-- an outbound call is kept too. (Rows written since 0018 name ids already kept: no conflict.)
INSERT INTO agboss_execution_ids (execution_id, tenant_id)
  SELECT record->>'executionId', tenant_id FROM agboss_outbound_calls
  WHERE record->>'executionId' IS NOT NULL
  ON CONFLICT (execution_id) DO NOTHING;
