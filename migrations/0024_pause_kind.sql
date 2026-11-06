-- agbossjs/agboss#801: a pause record stores what it waits for — kind 'approval' (a tool call) or
-- 'question' (a question role, #659, #712) — and names the step that asks as step (it was agent,
-- though a question step is no agent). The store reads kind as written and never infers it from
-- the component any more. A row written before has neither: it is rewritten by the rule it was
-- written under — a question role's component is a question, every other pause an approval (a row
-- from before components, #268 S93, too) — and agent becomes step.
-- A row with no text agent is left as it is and refused when read. Run it once no instance of an
-- earlier version writes pauses: a pause such an instance writes after it has no kind and is
-- refused unread (@agboss/postgres is first released with it, so no released version wrote one).
UPDATE agboss_pauses SET record = (record - 'agent') || jsonb_build_object(
    'step', record->'agent',
    'kind', CASE WHEN record #>> '{component,kind}' = 'question' THEN 'question' ELSE 'approval' END)
  WHERE NOT record ? 'kind' AND jsonb_typeof(record->'agent') = 'string';
