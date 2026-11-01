-- agbossjs/agboss#663: a ParentInstance child of before that paused (a tool call waiting for
-- approval) and sent nothing has no lease row and no outbound call, so 0018 and 0019 kept no id of
-- it. Its pause is found by its step key `<executionId>:<node>:<visit>[:<item>]:<callId>`, which
-- names no tree: a new execution minted with that id would make the same key and take the old
-- pause's decision without asking anyone. Every execution that paused is kept, with its tree
-- (record.executionId as written: its strings escaped U+E000 → U+E000 U+E000, 0013; an id holds
-- no NUL). And a pause is found by its step key in its tree from now on: unique per tenant, root
-- execution and step key, so even an id the kept ids miss never matches another tree's pause.
INSERT INTO agboss_execution_ids (execution_id, tenant_id)
  SELECT replace(record->>'executionId', U&'\E000\E000', U&'\E000'), tenant_id FROM agboss_pauses
  WHERE record->>'executionId' IS NOT NULL
  ON CONFLICT (execution_id) DO NOTHING;

INSERT INTO agboss_execution_ids (execution_id, tenant_id)
  SELECT root_execution_id, tenant_id FROM agboss_pauses
  ON CONFLICT (execution_id) DO NOTHING;

ALTER TABLE agboss_pauses
  DROP CONSTRAINT agboss_pauses_tenant_id_step_key_key,
  ADD CONSTRAINT agboss_pauses_tenant_id_root_execution_id_step_key_key
    UNIQUE (tenant_id, root_execution_id, step_key);
