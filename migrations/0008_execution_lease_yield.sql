-- ExecutionLeaseRepository.yield (agbossjs/agboss#516): a holder waiting for children on any
-- instance yields its lease — still its own, renewed on, refused to every other acquire until it
-- expires — and reclaims it at the next epoch. `yielded` says which leases wait so.
ALTER TABLE agboss_execution_leases ADD COLUMN yielded boolean NOT NULL DEFAULT false;
