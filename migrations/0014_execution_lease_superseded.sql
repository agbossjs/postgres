-- OutboundCallRepository.leaseStateOf (agbossjs/agboss#508): an expired lease a pending outbound
-- call was written under is closed by the check itself — released at its epoch, so its holder can
-- neither renew, yield, reclaim nor write under it again. `superseded` says it was closed so, not
-- by its holder: the next take is a takeover from that holder at that epoch (`takenOverFrom`).
ALTER TABLE agboss_execution_leases ADD COLUMN superseded boolean NOT NULL DEFAULT false;
