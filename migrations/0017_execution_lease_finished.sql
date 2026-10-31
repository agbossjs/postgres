-- ExecutionLeaseRepository.finish (agbossjs/agboss#520): the holder gave its lease up for good, the
-- work under it over (an AnyInstance child answered or failed). A finished lease is released too,
-- and `acquire` never takes its key again, so no stale instance takes over finished work. Rows
-- written before this migration are not finished: they are taken, renewed and released as before.
ALTER TABLE agboss_execution_leases ADD COLUMN finished boolean NOT NULL DEFAULT false;
