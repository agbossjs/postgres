import type { TurnOutcome } from "@agboss/core";
import type pg from "pg";
import { z } from "zod";
import { firstRowOf } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { seedTreeRow } from "../cancel-fence.js";
import { completedIn, type CompleteWrite } from "./record-complete.js";

/**
 * A finish conditional on its tree's marks (agbossjs/agboss#1341b): in the write's own transaction
 * the tree's lease row is seeded when there is none and read `FOR SHARE`, so a stop or cancel mark
 * (written `FOR UPDATE` on that row, in a transaction of its own) either committed before the read —
 * the finish is refused, nothing written — or waits for the finish. A finish never lands over a mark.
 */

const TreeRow = z.object({ tenant_id: z.string(), run_id: z.string().nullable() });
const MarkRow = z.object({ is_interrupted: z.boolean() });

/** The finish's record, written like `complete` unless its tree carries a stop or cancel mark; whether it was written. */
export function completeUnlessInterrupted(
  pool: pg.Pool,
  id: string,
  outcome: TurnOutcome,
  write: Pick<CompleteWrite, "now" | "context">,
): Promise<boolean> {
  return inPoolTransaction(pool, async (client) => {
    const read = await firstRowOf(
      client,
      "SELECT tenant_id, run_id FROM agboss_execution_records WHERE id = $1",
      [id],
    );
    const tree = read === undefined ? undefined : TreeRow.parse(read);
    if (tree?.run_id != null) {
      const root = { tenantId: tree.tenant_id, rootExecutionId: tree.run_id };
      await seedTreeRow(client, root, write.now);
      const marks = await firstRowOf(
        client,
        `SELECT cancel_requested_at IS NOT NULL OR stop_mode IS NOT NULL AS is_interrupted
         FROM agboss_execution_leases WHERE tenant_id = $1 AND root_execution_id = $2 FOR SHARE`,
        [root.tenantId, root.rootExecutionId],
      );
      if (marks !== undefined && MarkRow.parse(marks).is_interrupted) return false;
    }
    return completedIn(client, id, outcome, write);
  });
}
