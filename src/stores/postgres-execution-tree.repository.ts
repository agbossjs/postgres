import {
  ExecutionTreeRepository,
  Injectable,
  type ExecutionTree,
  type ExecutionTreeValue,
} from "@agboss/core";
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";

/** A stored value as JSON gives it back: what `saveIfAbsentInTree` wrote. */
const TreeValue: z.ZodType<ExecutionTreeValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(TreeValue),
    z.record(z.string(), TreeValue),
  ]),
);

const ValueRow = z.object({ value: z.unknown() });

/**
 * `ExecutionTreeRepository` on PostgreSQL (#265, #482): one row per key of a tree, its value as
 * `jsonb`. `saveIfAbsentInTree` is one `INSERT … ON CONFLICT DO NOTHING RETURNING`, so of two
 * instances saving one key exactly one gets `true` (the other's insert waits for the first's
 * row, then does nothing). Listed in `@Application({ providers })` with `postgresUrl`.
 */
@Injectable({ deps: [PostgresConnection] })
export class PostgresExecutionTreeRepository extends ExecutionTreeRepository {
  constructor(private readonly connection: PostgresConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async saveIfAbsentInTree(
    tree: ExecutionTree,
    key: string,
    value: ExecutionTreeValue,
  ): Promise<boolean> {
    const saved = await changesOf(
      this.connection.pool,
      `INSERT INTO agboss_execution_tree_keys (tenant_id, root_execution_id, tree_key, value)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING RETURNING 1`,
      [tree.tenantId, tree.rootExecutionId, key, JSON.stringify(value)],
    );
    return saved === 1;
  }

  async findByIdInTree(tree: ExecutionTree, key: string): Promise<ExecutionTreeValue | undefined> {
    const row = await firstRowOf(
      this.connection.pool,
      `SELECT value FROM agboss_execution_tree_keys
       WHERE tenant_id = $1 AND root_execution_id = $2 AND tree_key = $3`,
      [tree.tenantId, tree.rootExecutionId, key],
    );
    return row === undefined ? undefined : TreeValue.parse(ValueRow.parse(row).value);
  }

  async deleteAllInTree(tree: ExecutionTree): Promise<void> {
    await changesOf(
      this.connection.pool,
      "DELETE FROM agboss_execution_tree_keys WHERE tenant_id = $1 AND root_execution_id = $2",
      [tree.tenantId, tree.rootExecutionId],
    );
  }
}
