-- agbossjs/agboss#808: a run's record is read by its id (ExecutionRecordRepository
-- findByTenantIdAndRunId): an A2A task's read repair finds its root record however many later turns
-- its thread has. An index only; safe to run while any version runs.
CREATE INDEX IF NOT EXISTS agboss_execution_records_by_run
  ON agboss_execution_records (tenant_id, run_id);
