/**
 * agbossjs/agboss#824: an A2A message whose insert conflicts with a row the retention sweep removes
 * before it is read is inserted again — and when that happens twice the call rejects: a store
 * never answers "saved" (`undefined`) for a message it did not store. A client whose `query` is
 * scripted stands in for the race; nothing connects.
 */
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { savedOrKept } from "../../src/stores/a2a-tasks/a2a-task-statements.js";

const MESSAGE = {
  tenantId: "default",
  ownerId: "alice",
  messageId: "m-1",
  requestHash: "h-1",
  taskId: "t-1",
  savedAt: new Date("2026-01-05T09:00:00.000Z"),
};

/** A client answering each statement in turn: an insert's row count, a read's rows. */
function scripted(...answers: readonly { rowCount?: number; rows?: unknown[] }[]) {
  const client = new pg.Client();
  const query = vi.spyOn(client, "query");
  for (const answer of answers)
    query.mockResolvedValueOnce({
      command: "",
      oid: 0,
      fields: [],
      rowCount: answer.rowCount ?? 0,
      rows: answer.rows ?? [],
    } as never);
  return { client, query };
}

describe("agbossjs/agboss#824: a message saved, or the one kept", () => {
  it("a conflicting row gone before it was read: inserted again, this call saved it", async () => {
    const { client, query } = scripted({ rowCount: 0 }, { rows: [] }, { rowCount: 1 });

    expect(await savedOrKept(client, MESSAGE)).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("gone twice: rejects, never answers saved", async () => {
    const { client } = scripted({ rowCount: 0 }, { rows: [] }, { rowCount: 0 }, { rows: [] });

    await expect(savedOrKept(client, MESSAGE)).rejects.toThrow(/gone, twice: nothing is saved/);
  });
});
