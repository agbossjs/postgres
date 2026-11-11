import { A2ADirectMessageSaveStatus, A2ATaskState } from "@agboss/core";
import { describe, expect, it } from "vitest";
import {
  migratePostgres,
  PostgresA2ADirectMessageRepository,
  PostgresA2ATaskRepository,
} from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { freshSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#860: migration 0030 on a database at 0029 — the direct messages' table, beside the
 * A2A task store's messages it claims ids among. A task message saved before it keeps its id: a
 * direct message of that id is refused, and the task is still found by it.
 */
const NINE = new Date("2026-01-05T09:00:00.000Z");

describe("migration 0030 adds the direct A2A messages", () => {
  it("#860: a task message of before keeps its id; a direct message under it is taken", async () => {
    const url = await freshSchema();
    await migrateWith(
      { url },
      migrationsIn(migrationsFolder({ "0030_a2a_direct_messages.sql": null })),
    );
    const tasks = new PostgresA2ATaskRepository(connectionTo(url));
    await tasks.saveIfAbsent({
      tenantId: "acme",
      taskId: "t-1",
      ownerId: "alice",
      contextId: "ctx-1",
      skill: "quote-workflow-start",
      status: { state: A2ATaskState.Submitted, pendingPauses: [] },
      acceptedAt: NINE,
      messageId: "m-1",
      requestHash: "h-1",
    });

    const report = await migratePostgres({ url });

    expect(report.applied.map((file) => file.version)).toEqual([30]);
    const save = await new PostgresA2ADirectMessageRepository(connectionTo(url)).saveIfAbsent({
      tenantId: "acme",
      ownerId: "alice",
      messageId: "m-1",
      requestHash: "h-1",
      skill: "quote-workflow-start",
      contextId: "ctx-1",
      attemptId: "run-1",
      startedAt: NINE,
      expiresAt: new Date(NINE.getTime() + 30_000),
      callsModel: true,
      createdAt: NINE,
    });
    expect(save).toEqual({ status: A2ADirectMessageSaveStatus.Taken });
    const key = { tenantId: "acme", ownerId: "alice", messageId: "m-1" };
    expect(await tasks.findByMessage(key)).toMatchObject({ taskId: "t-1" });
  });
});
