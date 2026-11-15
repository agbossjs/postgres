-- A tree's cancel request (agbossjs/agboss#909): the durable mark `ExecutionLeaseRepository.requestCancel`
-- writes — keyed by the tree's root, never by a child's lease, and possible before the tree's first
-- acquire (no lease row to hang it on) — and every fenced write reads in the transaction that
-- checks its lease: from the mark on, a new effect, intent or attempt of the tree is refused
-- (ExecutionCancelFencedError). Written and read under the advisory lock of the tree's identity
-- (namespace 909), so a cancel waits for the tree's open fencing transactions and one that starts
-- later reads the committed mark. Pruned by the fencing stores' retention (requested_at).
CREATE TABLE IF NOT EXISTS agboss_execution_cancel_requests (
  tenant_id text NOT NULL,
  root_execution_id text NOT NULL,
  requested_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, root_execution_id)
);
CREATE INDEX IF NOT EXISTS agboss_execution_cancel_requests_by_requested_at
  ON agboss_execution_cancel_requests (requested_at);
