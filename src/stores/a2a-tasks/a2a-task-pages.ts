import type { A2ATaskPage, A2ATaskQuery } from "@agboss/core";
import { rowsOf, type Queryable } from "../../connection/query.js";
import { ownerColumnOf, pagePositionOf, pageTokenOf, taskOf, totalOf } from "./a2a-task-rows.js";

/**
 * `list` of `PostgresA2ATaskRepository` (agbossjs/agboss#824): a caller's tasks newest status
 * first (ties by task id, descending, byte-wise), filtered by context, state and status time, a page
 * after the token's position, and how many the filters match before paging.
 */

/** The filters of `query` as SQL and parameters, from `$1`. */
function filtersOf(query: A2ATaskQuery): { readonly where: string[]; readonly values: unknown[] } {
  const where = ["tenant_id = $1", "owner_id = $2"];
  const values: unknown[] = [query.tenantId, ownerColumnOf(query.ownerId)];
  const add = (sql: (at: string) => string, value: unknown): void => {
    values.push(value);
    where.push(sql(`$${String(values.length)}`));
  };
  if (query.contextId !== undefined) add((at) => `context_id = ${at}`, query.contextId);
  if (query.state !== undefined) add((at) => `state = ${at}`, query.state);
  if (query.statusAtAfter !== undefined) add((at) => `status_at > ${at}`, query.statusAtAfter);
  return { where, values };
}

/** The page `query` asks for; `InvalidA2APageTokenError` for a token no list gave. */
export async function pageOf(database: Queryable, query: A2ATaskQuery): Promise<A2ATaskPage> {
  const token = query.pageToken ?? "";
  const position = token === "" ? undefined : pagePositionOf(token);
  const { where, values } = filtersOf(query);
  const after = [...where];
  const afterValues = [...values];
  if (position !== undefined) {
    const [at, id] = [afterValues.length + 1, afterValues.length + 2];
    after.push(
      `(status_at < $${String(at)} OR (status_at = $${String(at)} AND task_id < $${String(id)}))`,
    );
    afterValues.push(position.statusAt, position.taskId);
  }
  afterValues.push(query.pageSize + 1);
  const rows = await rowsOf(
    database,
    `SELECT * FROM agboss_a2a_tasks WHERE ${after.join(" AND ")}
     ORDER BY status_at DESC, task_id DESC LIMIT $${String(afterValues.length)}`,
    afterValues,
  );
  const [counted] = await rowsOf(
    database,
    `SELECT count(*) AS total FROM agboss_a2a_tasks WHERE ${where.join(" AND ")}`,
    values,
  );
  const tasks = rows.slice(0, query.pageSize).map(taskOf);
  const last = tasks.at(-1);
  return {
    tasks,
    nextPageToken: rows.length > query.pageSize && last !== undefined ? pageTokenOf(last) : "",
    totalSize: totalOf(counted),
  };
}
