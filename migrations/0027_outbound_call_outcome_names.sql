-- agbossjs/agboss#825: the lease log names the three meanings of "superseded" apart. An outbound
-- call's row with outcome 'superseded' (an attempt answered after a newer one took its intent over)
-- is 'attempt-superseded'; one with 'lease-superseded' (a lease an outbound call's check closed) is
-- 'lease-closed', its supersededLease now closedLease. The rows of the lease log, and the copies a
-- kept record holds of them (its leaseEvents), are rewritten in place; every other row is left as
-- it is. A row an instance of an earlier version writes after it would be refused when read: run it
-- once none does (@agboss/postgres is first released with it, so no released version wrote one).
CREATE FUNCTION pg_temp.agboss_outbound_call_outcome_named(item jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
      WHEN item->>'kind' <> 'outbound-call' OR item->>'outcome' NOT IN ('superseded', 'lease-superseded')
        THEN item
      ELSE (item - 'supersededLease')
        || jsonb_build_object('outcome',
             CASE item->>'outcome' WHEN 'superseded' THEN 'attempt-superseded' ELSE 'lease-closed' END)
        || CASE WHEN item ? 'supersededLease'
             THEN jsonb_build_object('closedLease', item->'supersededLease') ELSE '{}'::jsonb END
    END
  $$;
UPDATE agboss_execution_lease_events
  SET record = pg_temp.agboss_outbound_call_outcome_named(record)
  WHERE record->>'kind' = 'outbound-call'
    AND record->>'outcome' IN ('superseded', 'lease-superseded');
UPDATE agboss_execution_history
  SET record = jsonb_set(record, '{leaseEvents}', (
    SELECT jsonb_agg(pg_temp.agboss_outbound_call_outcome_named(event) ORDER BY place)
      FROM jsonb_array_elements(record->'leaseEvents') WITH ORDINALITY AS events(event, place)))
  WHERE jsonb_typeof(record->'leaseEvents') = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(record->'leaseEvents') AS events(event)
        WHERE event->>'kind' = 'outbound-call'
          AND event->>'outcome' IN ('superseded', 'lease-superseded'));
DROP FUNCTION pg_temp.agboss_outbound_call_outcome_named(jsonb);
