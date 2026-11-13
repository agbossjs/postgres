import {
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
  A2ATaskSaveStatus,
  A2ATaskState,
  type NewA2ADirectMessage,
} from "@agboss/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PostgresA2ADirectMessageRepository, PostgresA2ATaskRepository } from "../../src/index.js";
import { savedDirectOnce } from "../../src/stores/a2a-direct-messages/a2a-direct-message-statements.js";
import { onSchema, testDatabase, truncateAll } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#860 on PostgreSQL, past the contract: a resend saving its row under a claim the
 * retention sweep is freeing keeps the claim (the save holds it `FOR KEY SHARE`, the sweep waits
 * for it and sees the row) — a direct message is never left with its id unclaimed, so a task
 * message of that id is still refused; and a row this store cannot read in full is refused.
 */
const database = testDatabase();

const NINE = new Date("2026-01-05T09:00:00.000Z");
const at = (seconds: number): Date => new Date(NINE.getTime() + seconds * 1000);

const newMessage = (extra: Partial<NewA2ADirectMessage> = {}): NewA2ADirectMessage => ({
  tenantId: "acme",
  ownerId: "alice",
  messageId: "m-1",
  requestHash: "h-1",
  skill: "quote-workflow-start",
  contextId: "ctx-1",
  attemptId: "run-1",
  startedAt: NINE,
  expiresAt: at(30),
  callsModel: true,
  createdAt: NINE,
  ...extra,
});

const KEY = { tenantId: "acme", ownerId: "alice", messageId: "m-1" };
const messagesOn = () => new PostgresA2ADirectMessageRepository(connectionTo(database.url(), 2));

const WaitingRow = z.object({ waiting: z.number() });

/** Resolves once a session waits on the session `pid`'s locks (the test's timeout bounds it). */
async function untilWaitingOn(pid: number): Promise<void> {
  const waiting = async (): Promise<number> => {
    const { rows } = await onSchema(
      database.url(),
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [pid],
    );
    return WaitingRow.parse(rows[0]).waiting;
  };
  while ((await waiting()) === 0) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("agbossjs/agboss#860: the direct messages on PostgreSQL", () => {
  beforeEach(async () => {
    await truncateAll(database.url());
  });

  it("a resend saved while the sweep frees its id keeps the claim: a task of the id is refused", async () => {
    const messages = messagesOn();
    await messages.saveIfAbsent(newMessage());
    // its attempt failed: the row is gone, its id stays claimed (saved at nine)
    await messages.deleteIfInFlight(KEY, "run-1");
    const resender = connectionTo(database.url(), 1);
    const client = await resender.pool.connect();
    const pidRow = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await client.query("BEGIN");
    // the resend's statements, as saveIfAbsent runs them, in a transaction held open
    const again = newMessage({ attemptId: "run-2", createdAt: at(120), startedAt: at(120) });
    const save = await savedDirectOnce(client, again, {
      ...again,
      state: A2ADirectMessageState.InFlight,
    });
    expect(save?.status).toBe(A2ADirectMessageSaveStatus.Saved);

    const sweep = messagesOn().deleteByCreatedAtBefore(at(60), 10);
    await untilWaitingOn(pidRow.rows[0]?.pid ?? -1);
    await client.query("COMMIT");
    client.release();

    expect(await sweep).toEqual([]);
    expect((await messages.findByKey(KEY))?.attemptId).toBe("run-2");
    const task = await new PostgresA2ATaskRepository(connectionTo(database.url(), 2)).saveIfAbsent({
      tenantId: "acme",
      taskId: "t-1",
      ownerId: "alice",
      contextId: "ctx-1",
      skill: "quote-workflow-start",
      status: { state: A2ATaskState.Submitted, pendingPauses: [] },
      acceptedAt: at(121),
      messageId: "m-1",
      requestHash: "h-9",
    });
    expect(task.status).toBe(A2ATaskSaveStatus.MessageTaken);
  });

  it.each([
    ["a field it does not know", { finish: "f", output: 1, spentUsd: 0, grantedUsd: 5 }],
    ["a negative spend", { finish: "f", output: 1, spentUsd: -1 }],
    ["no finish", { output: 1, spentUsd: 0 }],
  ])("a reply with %s is refused, never read without it", async (_name, reply) => {
    const messages = messagesOn();
    await messages.saveIfAbsent(newMessage());
    await messages.completeIfInFlight(KEY, "run-1", { finish: "f", output: 1, spentUsd: 0 }, at(5));
    await onSchema(
      database.url(),
      "UPDATE agboss_a2a_direct_messages SET reply = $1::jsonb WHERE message_id = 'm-1'",
      [JSON.stringify(reply)],
    );

    await expect(messages.findByKey(KEY)).rejects.toThrow();
  });

  it("the table refuses a row whose state and reply disagree", async () => {
    const messages = messagesOn();
    await messages.saveIfAbsent(newMessage());

    for (const set of [
      "state = 'completed'",
      `reply = '{"finish":"f","output":1,"spentUsd":0}'`,
      "completed_at = now()",
      "state = 'lost'",
    ])
      await expect(
        onSchema(database.url(), `UPDATE agboss_a2a_direct_messages SET ${set}`),
      ).rejects.toThrow(/violates check constraint/);
  });

  it("a row whose state and reply disagree is refused, every way (past the table's check)", async () => {
    const messages = messagesOn();
    await onSchema(
      database.url(),
      `ALTER TABLE agboss_a2a_direct_messages
         DROP CONSTRAINT agboss_a2a_direct_messages_reply_check`,
    );
    await messages.saveIfAbsent(newMessage());
    await messages.saveIfAbsent(newMessage({ messageId: "m-2" }));
    await messages.saveIfAbsent(newMessage({ messageId: "m-3" }));
    await onSchema(
      database.url(),
      `UPDATE agboss_a2a_direct_messages SET state = 'completed' WHERE message_id = 'm-1';
       UPDATE agboss_a2a_direct_messages SET reply = '{"finish":"f","output":1,"spentUsd":0}',
         completed_at = now() WHERE message_id = 'm-2';
       UPDATE agboss_a2a_direct_messages SET reply = '{"finish":"f","output":1,"spentUsd":0}'
         WHERE message_id = 'm-3'`,
    );

    await expect(messages.findByKey(KEY)).rejects.toThrow(/its state and its reply disagree/);
    await expect(messages.findByKey({ ...KEY, messageId: "m-2" })).rejects.toThrow(
      /its state and its reply disagree/,
    );
    await expect(messages.findByKey({ ...KEY, messageId: "m-3" })).rejects.toThrow(
      /its state and its reply disagree/,
    );
  });
});
