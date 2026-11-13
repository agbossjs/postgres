import {
  A2ATaskSaveStatus,
  A2ATaskState,
  type A2AMessageRecord,
  type A2ATaskRecord,
  type NewA2ATask,
} from "@agboss/core";
import { describe, expect, it, vi } from "vitest";
import { PostgresA2ATaskRepository } from "../../src/index.js";
import {
  insertedMessage,
  insertedTask,
  taskFieldsOf,
} from "../../src/stores/a2a-tasks/a2a-task-statements.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#960 on PostgreSQL, the interleaving that charged a skill twice on MongoDB: sweep A
 * reads an orphan message, sweep B removes it, a resend creates a new task under the same message
 * id, sweep A deletes what it read. PostgreSQL deletes the orphans in one statement, so the
 * interleaving is made inside it, deterministically: a transaction holds the orphan's row lock, so
 * sweep A's statement, its snapshot taken, waits at that row; the transaction (sweep B and the
 * resend) removes the orphan, saves the new task and commits; sweep A then goes on. The new task is
 * created in every round, not in one of sixty as a race of free-running calls would.
 */
const database = testDatabase();
const NINE = new Date("2026-01-05T09:00:00.000Z");
const at = (minutes: number): Date => new Date(NINE.getTime() + minutes * 60_000);

const newTask = (taskId: string, messageId: string, acceptedAt: Date): NewA2ATask => ({
  tenantId: "default",
  taskId,
  ownerId: "alice",
  contextId: "ctx-1",
  skill: "s",
  status: { state: A2ATaskState.Submitted, pendingPauses: [] },
  acceptedAt,
  messageId,
  requestHash: "h-1",
});

const ROUNDS = 5;

describe("agbossjs/agboss#960: the PostgreSQL orphan sweep against a resend of the orphan's message id", () => {
  it(`a sweep paused at the orphan's row never removes the message of the new task created meanwhile (${String(ROUNDS)} rounds)`, async () => {
    const holder = connectionTo(database.url());
    const sweeping = connectionTo(database.url());
    const tasks = new PostgresA2ATaskRepository(sweeping);
    for (let round = 0; round < ROUNDS; round += 1) {
      const orphan: A2AMessageRecord = {
        tenantId: "default",
        ownerId: "alice",
        messageId: `m-x${String(round)}`,
        requestHash: "h-1",
        taskId: "t-gone",
        savedAt: at(1),
      };
      expect(await tasks.saveMessageIfAbsent(orphan)).toBeUndefined();
      const resend = newTask(`t-20-${String(round)}`, orphan.messageId, at(20));

      const client = await holder.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT 1 FROM agboss_a2a_messages WHERE tenant_id = $1 AND owner_id = $2 AND message_id = $3 FOR UPDATE",
          [orphan.tenantId, orphan.ownerId, orphan.messageId],
        );
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid;
        // sweep A: its statement reads the orphan and waits at its row
        const sweepA = tasks.deleteTerminalByStatusAtBefore(at(10));
        await vi.waitFor(async () => {
          const waiting = await client.query(
            "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [pid],
          );
          expect(waiting.rowCount).toBe(1);
        });
        // sweep B removes the orphan; the client's resend is accepted as a new task
        await client.query(
          "DELETE FROM agboss_a2a_messages WHERE tenant_id = $1 AND owner_id = $2 AND message_id = $3",
          [orphan.tenantId, orphan.ownerId, orphan.messageId],
        );
        const record: A2ATaskRecord = { ...taskFieldsOf(resend), version: 1, statusAt: at(20) };
        expect(await insertedTask(client, record)).toBe(true);
        expect(
          await insertedMessage(client, { ...orphan, taskId: resend.taskId, savedAt: at(20) }),
        ).toBe(true);
        // the commit lets sweep A go on, after the new task exists
        await client.query("COMMIT");
        await sweepA;
      } finally {
        client.release();
      }

      expect(await tasks.findById({ tenantId: "default", taskId: resend.taskId })).toBeDefined();
      expect(await tasks.findByMessage(orphan)).toMatchObject({ taskId: resend.taskId });
      const again = await tasks.saveIfAbsent(
        newTask(`t-30-${String(round)}`, orphan.messageId, at(21)),
      );
      expect(again.status).toBe(A2ATaskSaveStatus.MessageTaken);
    }
  });
});
