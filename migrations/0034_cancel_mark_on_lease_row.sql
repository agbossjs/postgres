-- agbossjs/agboss#1117: a tree's cancel mark is permanent and lives on the tree's lease row
-- (`cancel_requested_at`), not in 0032's `agboss_execution_cancel_requests`, whose retention lifted it
-- once the root's lease was retired while a child's lease of the tree was still live. The mark is set
-- once by `requestCancel` and never cleared; the fencing transactions read it with a share lock on
-- the root's row, which the cancel's write waits for — advisory lock 909 is gone. A cancel before the
-- tree's first acquire writes a seed row: token 0, released, never held (the first acquire is token
-- 1, no takeover), so the token's check allows 0.
-- Every mark of the old table moves onto its tree's row (a tree with no row gets a seed row; a mark
-- the row already has stays), then the table is dropped. In one transaction; written to rerun. Run it
-- once no instance of an earlier version runs (ADR-0034): such an instance writes the old table and
-- would lose its marks. The migration runs under the live-lease guard (agbossjs/agboss#1104).
ALTER TABLE agboss_execution_leases ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
ALTER TABLE agboss_execution_leases DROP CONSTRAINT IF EXISTS agboss_execution_leases_token_check;
ALTER TABLE agboss_execution_leases
  ADD CONSTRAINT agboss_execution_leases_token_check CHECK (token >= 0);
DO $$
BEGIN
  IF to_regclass('agboss_execution_cancel_requests') IS NOT NULL THEN
    INSERT INTO agboss_execution_leases
      (tenant_id, root_execution_id, holder_instance_id, token, expires_at, released,
        cancel_requested_at)
    SELECT tenant_id, root_execution_id, '', 0, requested_at, true, requested_at
      FROM agboss_execution_cancel_requests
    ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
      cancel_requested_at = COALESCE(agboss_execution_leases.cancel_requested_at,
        EXCLUDED.cancel_requested_at);
    DROP TABLE agboss_execution_cancel_requests;
  END IF;
END
$$;
