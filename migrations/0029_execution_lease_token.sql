-- agbossjs/agboss#847 (API review G7): a lease's fencing token is named `token` everywhere — the
-- core's `ExecutionLease.token`, the fence's `ExecutionFencedError.token` and this column, which
-- was `lease_epoch`. A rename in place: every row keeps its value, its NOT NULL and its CHECK
-- (now `token >= 1`, its constraint named after it), so a tree's next take is still its last
-- token + 1 and no token is handed out twice. An instance of an earlier version names the old
-- column and fails each lease statement once it ran (closed: no lease taken, renewed or fenced):
-- run it once none does (@agboss/postgres is first released with it, so no released version runs).
ALTER TABLE agboss_execution_leases RENAME COLUMN lease_epoch TO token;
ALTER TABLE agboss_execution_leases
  RENAME CONSTRAINT agboss_execution_leases_lease_epoch_check TO agboss_execution_leases_token_check;
