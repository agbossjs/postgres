import {
  A2ATaskRepository,
  A2ATaskSaveStatus,
  Injectable,
  type A2AMessageKey,
  type A2AMessageRecord,
  type A2ATaskKey,
  type A2ATaskPage,
  type A2ATaskQuery,
  type A2ATaskRecord,
  type A2ATaskSave,
  type A2ATaskStatus,
  type NewA2ATask,
} from "@agboss/core";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, rowsOf } from "../connection/query.js";
import { inPoolTransaction } from "../connection/transaction.js";
import { MESSAGE_KEY, messageKeyOf, TERMINAL_STATES, taskOf } from "./a2a-tasks/a2a-task-rows.js";
import { pageOf } from "./a2a-tasks/a2a-task-pages.js";
import {
  insertedTask,
  messageAt,
  savedOrKept,
  taskAt,
  taskFieldsOf,
} from "./a2a-tasks/a2a-task-statements.js";
import { escapedJsonOf } from "./nul-escape.js";

/**
 * `A2ATaskRepository` on PostgreSQL (agbossjs/agboss#824): the A2A tasks an application serves,
 * shared by every instance on the database — a message resent to any pod finds the task it was
 * accepted for, `GetTask` on any pod reads it. A task row and a row per accepted message
 * (migration 0026), the status as `jsonb`.
 *
 * - `saveIfAbsent` is one transaction at `READ COMMITTED`: the message's
 *   `INSERT … ON CONFLICT DO NOTHING` first — of two pods accepting one message the second's insert
 *   waits for the first's row, then does nothing and reads the task it was accepted for — then the
 *   task's; a task id another message's task has removes the message again, so nothing is saved.
 * - `compareAndSetStatus` is one `UPDATE … WHERE version = $n AND state NOT IN (terminal)`: of two
 *   writers at one version exactly one changes the row; a terminal status is never written over.
 * - `saveMessageIfAbsent` is one insert, or the read of the message kept (inserted again when the
 *   sweep removed it in between: never "saved" for a message not stored); `saveReplyIfAbsent` one
 *   statement.
 * - `list` reads the page and its count in two statements: a task saved in between moves the
 *   count by one, as the next page would show it.
 * - `deleteTerminalByStatusAtBefore` removes a finished task's messages and the task in one
 *   transaction, the cutoff the `Clock`'s.
 *
 * Listed in `@Application({ providers })` with `postgresUrl`.
 */
@Injectable({ deps: [PostgresConnection] })
export class PostgresA2ATaskRepository extends A2ATaskRepository {
  static override readonly backend: string | undefined = "postgres";

  constructor(private readonly connection: PostgresConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  saveIfAbsent(task: NewA2ATask): Promise<A2ATaskSave> {
    return inPoolTransaction(this.connection.pool, async (client): Promise<A2ATaskSave> => {
      const message: A2AMessageRecord = {
        tenantId: task.tenantId,
        ownerId: task.ownerId,
        messageId: task.messageId,
        requestHash: task.requestHash,
        taskId: task.taskId,
        savedAt: task.acceptedAt,
      };
      const kept = await savedOrKept(client, message);
      if (kept !== undefined)
        return {
          status: A2ATaskSaveStatus.MessageTaken,
          message: kept,
          task: await taskAt(client, kept),
        };
      const record: A2ATaskRecord = {
        ...taskFieldsOf(task),
        version: 1,
        statusAt: task.acceptedAt,
      };
      if (!(await insertedTask(client, record))) {
        await changesOf(
          client,
          `DELETE FROM agboss_a2a_messages WHERE ${MESSAGE_KEY}`,
          messageKeyOf(task),
        );
        return { status: A2ATaskSaveStatus.TaskIdTaken };
      }
      return { status: A2ATaskSaveStatus.Saved, task: record };
    });
  }

  async saveMessageIfAbsent(message: A2AMessageRecord): Promise<A2AMessageRecord | undefined> {
    return savedOrKept(this.connection.pool, message);
  }

  async saveReplyIfAbsent(key: A2AMessageKey, reply: unknown): Promise<boolean> {
    const changed = await changesOf(
      this.connection.pool,
      `UPDATE agboss_a2a_messages SET reply = $4::jsonb WHERE ${MESSAGE_KEY} AND reply IS NULL`,
      [...messageKeyOf(key), escapedJsonOf(reply)],
    );
    return changed === 1;
  }

  findById(key: A2ATaskKey): Promise<A2ATaskRecord | undefined> {
    return taskAt(this.connection.pool, key);
  }

  findByMessage(key: A2AMessageKey): Promise<A2AMessageRecord | undefined> {
    return messageAt(this.connection.pool, key);
  }

  async compareAndSetStatus(
    key: A2ATaskKey,
    expectedVersion: number,
    status: A2ATaskStatus,
    statusAt: Date,
  ): Promise<A2ATaskRecord | undefined> {
    const [row] = await rowsOf(
      this.connection.pool,
      `UPDATE agboss_a2a_tasks SET state = $4, status = $5::jsonb, version = version + 1,
         status_at = $6
       WHERE tenant_id = $1 AND task_id = $2 AND version = $3 AND NOT (state = ANY($7::text[]))
       RETURNING *`,
      [
        key.tenantId,
        key.taskId,
        expectedVersion,
        status.state,
        escapedJsonOf(status),
        statusAt,
        TERMINAL_STATES,
      ],
    );
    return row === undefined ? undefined : taskOf(row);
  }

  list(query: A2ATaskQuery): Promise<A2ATaskPage> {
    return pageOf(this.connection.pool, query);
  }

  async deleteTerminalByStatusAtBefore(cutoff: Date): Promise<void> {
    const gone = "t.state = ANY($1::text[]) AND t.status_at < $2";
    await inPoolTransaction(this.connection.pool, async (client) => {
      await changesOf(
        client,
        `DELETE FROM agboss_a2a_messages m USING agboss_a2a_tasks t
         WHERE t.tenant_id = m.tenant_id AND t.task_id = m.task_id AND ${gone}`,
        [TERMINAL_STATES, cutoff],
      );
      await changesOf(client, `DELETE FROM agboss_a2a_tasks t WHERE ${gone}`, [
        TERMINAL_STATES,
        cutoff,
      ]);
    });
  }
}
