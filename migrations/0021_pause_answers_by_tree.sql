-- agbossjs/agboss#676: the pause answer log behind record.pauses kept one answer per tenant and
-- step key, and a step key `<executionId>:<node>:<visit>[:<item>]:<callId>` names no tree. Since
-- #663 (0020) another tree's pause under the same key — an id minted again that the kept ids miss —
-- is a pause of its own and is asked again, but its answer was dropped (ON CONFLICT DO NOTHING).
-- One answer per pause of a tree from now on; every row, and its seq (the order of ties), kept.
ALTER TABLE agboss_pause_answers
  DROP CONSTRAINT agboss_pause_answers_pkey,
  ADD PRIMARY KEY (tenant_id, root_execution_id, step_key);
