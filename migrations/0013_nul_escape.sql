-- agbossjs/agboss#521: PostgreSQL keeps no NUL character (U+0000) — text refuses it, jsonb refuses
-- the escape \u0000 — so the stores now escape every framework string they keep in jsonb or as free
-- text: U+0000 → U+E000 '0', U+E000 → U+E000 U+E000 (src/stores/nul-escape.ts). A row written
-- before holds no U+0000, but may hold U+E000 (a private-use character): it is doubled here, so it
-- reads back as it was written. U+E000 occurs in JSON text only inside strings.
UPDATE agboss_execution_records SET
  task = replace(task, chr(57344), chr(57344) || chr(57344)),
  reply_with = replace(reply_with, chr(57344), chr(57344) || chr(57344)),
  stop_reason = replace(stop_reason, chr(57344), chr(57344) || chr(57344)),
  route = replace(route::text, chr(57344), chr(57344) || chr(57344))::jsonb,
  steps = replace(steps::text, chr(57344), chr(57344) || chr(57344))::jsonb
WHERE strpos(task || reply_with || stop_reason || route::text || steps::text, chr(57344)) > 0;

UPDATE agboss_execution_summaries SET text = replace(text, chr(57344), chr(57344) || chr(57344))
WHERE strpos(text, chr(57344)) > 0;

UPDATE agboss_execution_tree_keys SET
  value = replace(value::text, chr(57344), chr(57344) || chr(57344))::jsonb
WHERE strpos(value::text, chr(57344)) > 0;

UPDATE agboss_pauses SET
  record = replace(record::text, chr(57344), chr(57344) || chr(57344))::jsonb
WHERE strpos(record::text, chr(57344)) > 0;

UPDATE agboss_execution_lease_events SET
  record = replace(record::text, chr(57344), chr(57344) || chr(57344))::jsonb
WHERE strpos(record::text, chr(57344)) > 0;

UPDATE agboss_execution_history SET
  record = replace(record::text, chr(57344), chr(57344) || chr(57344))::jsonb
WHERE strpos(record::text, chr(57344)) > 0;

UPDATE agboss_mesh_requests SET
  response = replace(response::text, chr(57344), chr(57344) || chr(57344))::jsonb
WHERE strpos(response::text, chr(57344)) > 0;
