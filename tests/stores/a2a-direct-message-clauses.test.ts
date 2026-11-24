import {
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
  type NewA2ADirectMessage,
} from "@agboss/core/stores";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresA2ADirectMessageRepository } from "../../src/index.js";
import {
  checkedLimit,
  directMessageOf,
} from "../../src/stores/a2a-direct-messages/a2a-direct-message-rows.js";
import {
  freedClaims,
  savedDirectOnce,
} from "../../src/stores/a2a-direct-messages/a2a-direct-message-statements.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/postgres#129: the direct-message store's guarantees, clause by clause, past the
 * contract — the once-only claim of a message when the rows it meets are gone or won by another
 * pod, the attempts of a save, a page's limit, a row whose state and reply disagree. The races
 * that cannot be made on a real server (a row gone between two statements) are scripted.
 */
const database = testDatabase({ migrated: false });
const NINE = new Date("2026-01-05T09:00:00.000Z");

const newMessage = (): NewA2ADirectMessage => ({
  endpoint: "ep-1",
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
const saved = () => ({ ...newMessage(), state: A2ADirectMessageState.InFlight });

/** A row of `agboss_a2a_direct_messages` as the driver gives it. */
const rowOf = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  endpoint: "ep-1",
  tenant_id: "acme",
  owner_id: "alice",
  message_id: "m-1",
  request_hash: "h-1",
  skill: "quote-workflow-start",
  context_id: "ctx-1",
  state: "in-flight",
  attempt_id: "run-other",
  calls_model: true,
  created_at: NINE,
  started_at: NINE,
  expires_at: new Date(NINE.getTime() + 30_000),
  caller_peer: null,
  mesh_body_hash: null,
  reply: null,
  completed_at: null,
  ...extra,
});

interface Answer {
  readonly rows?: readonly unknown[];
  readonly rowCount?: number;
}
type Route = (sql: string) => Answer;

/** A connection (never opened) that answers each statement by `route`, and records the statements run. */
function scripted(route: Route): {
  readonly client: pg.PoolClient;
  readonly statements: string[];
} {
  const statements: string[] = [];
  const client = Object.assign(new pg.Client(), { release: () => undefined });
  Reflect.set(client, "query", (sql: string) => {
    statements.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
    const { rows = [], rowCount = rows.length } = route(sql);
    return Promise.resolve({ rows, rowCount });
  });
  return { client, statements };
}

const isClaimInsert = (sql: string): boolean => sql.includes("INSERT INTO agboss_a2a_messages");
const isRowInsert = (sql: string): boolean =>
  sql.includes("INSERT INTO agboss_a2a_direct_messages");
const isRowRead = (sql: string): boolean =>
  sql.startsWith("SELECT * FROM agboss_a2a_direct_messages");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agbossjs/postgres#129: the once-only claim of a direct message", () => {
  it("names its store", () => {
    expect(PostgresA2ADirectMessageRepository.store).toEqual({ backend: "postgres" });
  });

  it("a claim that was kept and is gone when read: nothing more is run, the save is tried again", async () => {
    const { client, statements } = scripted((sql) =>
      isClaimInsert(sql) ? { rowCount: 0 } : { rows: [] },
    );

    expect(await savedDirectOnce(client, newMessage(), saved())).toBeUndefined();

    expect(statements).toEqual(["INSERT INTO agboss_a2a_messages", "SELECT tenant_id, owner_id,"]);
  });

  it("a row another pod inserted under the claim this one holds too is the answer: kept, its attempt", async () => {
    let reads = 0;
    const { client } = scripted((sql) => {
      if (isClaimInsert(sql)) return { rowCount: 1 };
      if (isRowRead(sql)) {
        reads += 1;
        // not there at the first read, the other pod's by the second
        return reads === 1 ? { rows: [] } : { rows: [rowOf()] };
      }
      if (isRowInsert(sql)) return { rowCount: 0 };
      return { rows: [] };
    });

    const save = await savedDirectOnce(client, newMessage(), saved());

    expect(save).toMatchObject({
      status: A2ADirectMessageSaveStatus.Kept,
      message: { attemptId: "run-other" },
    });
  });

  it("a row that vanished again after the lost insert: tried again, not an answer", async () => {
    const { client } = scripted((sql) => {
      if (isClaimInsert(sql)) return { rowCount: 1 };
      if (isRowInsert(sql)) return { rowCount: 0 };
      return { rows: [] };
    });

    expect(await savedDirectOnce(client, newMessage(), saved())).toBeUndefined();
  });

  it("a claim this pod inserted and a row it inserted: saved, as given", async () => {
    const { client } = scripted((sql) =>
      isClaimInsert(sql) || isRowInsert(sql) ? { rowCount: 1 } : { rows: [] },
    );

    expect(await savedDirectOnce(client, newMessage(), saved())).toEqual({
      status: A2ADirectMessageSaveStatus.Saved,
      message: saved(),
    });
  });

  it("is tried twice: the second try's answer is the save's, and two vanished rows are an error", async () => {
    const connection = connectionTo(database.url());
    const repository = new PostgresA2ADirectMessageRepository(connection);
    let claims = 0;
    const gone = scripted((sql) => {
      if (isClaimInsert(sql)) {
        claims += 1;
        return { rowCount: 0 };
      }
      return { rows: [] };
    });
    vi.spyOn(connection.pool, "connect").mockResolvedValue(gone.client as never);

    await expect(repository.saveIfAbsent(newMessage())).rejects.toThrow(
      "a direct A2A message's rows conflicted, then were gone, twice: nothing is saved",
    );
    expect(claims).toBe(2);

    // the first try finds the rows gone, the second saves
    claims = 0;
    const second = scripted((sql) => {
      if (isClaimInsert(sql)) {
        claims += 1;
        return { rowCount: claims === 1 ? 0 : 1 };
      }
      return isRowInsert(sql) ? { rowCount: 1 } : { rows: [] };
    });
    vi.spyOn(connection.pool, "connect").mockResolvedValue(second.client as never);

    expect(await repository.saveIfAbsent(newMessage())).toMatchObject({
      status: A2ADirectMessageSaveStatus.Saved,
    });
    expect(claims).toBe(2);
  });
});

describe("agbossjs/postgres#129: the sweep of orphaned claims", () => {
  it("locks the orphans and asks nothing more when there are none", async () => {
    const { client, statements } = scripted(() => ({ rows: [] }));

    await freedClaims(client, "ep-1", NINE, 5);

    expect(statements).toEqual(["SELECT tenant_id, owner_id,"]);
  });

  it("deletes the claims it locked, by their keys", async () => {
    const { client, statements } = scripted((text) =>
      text.startsWith("SELECT")
        ? {
            rows: [
              {
                endpoint: "ep-1",
                tenant_id: "acme",
                owner_id: "alice",
                message_id: "m-1",
                request_hash: "h-1",
                task_id: "x",
                saved_at: NINE,
                reply: null,
                answered: false,
              },
            ],
          }
        : { rowCount: 1 },
    );

    await freedClaims(client, "ep-1", NINE, 5);

    expect(statements).toEqual(["SELECT tenant_id, owner_id,", "DELETE FROM agboss_a2a_messages"]);
  });
});

describe("agbossjs/postgres#129: a page's limit and a row's reply", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses the limit %s", (limit) => {
    expect(() => checkedLimit(limit)).toThrow(
      new RangeError(
        `a page of direct A2A messages holds a whole number from 1, not ${String(limit)}`,
      ),
    );
  });

  it("gives back a whole number from 1", () => {
    expect([1, 2, 500].map(checkedLimit)).toEqual([1, 2, 500]);
  });

  const REPLY = { finish: "f", output: 1, spentUsd: 0 };
  it.each([
    [
      "a reply, a completion time and the state in flight",
      rowOf({ reply: REPLY, completed_at: NINE }),
    ],
    ["a completion time and no reply", rowOf({ completed_at: NINE })],
    [
      "the state completed with a reply and no completion time",
      rowOf({ state: "completed", reply: REPLY }),
    ],
    ["the state completed, no reply, no completion time", rowOf({ state: "completed" })],
    ["a reply and no completion time, in flight", rowOf({ reply: REPLY })],
  ])("refuses a row with %s", (_name, row) => {
    expect(() => directMessageOf(row)).toThrow(
      "agboss_a2a_direct_messages row m-1: its state and its reply disagree",
    );
  });

  it("reads a row whose state, reply and completion time agree", () => {
    expect(
      directMessageOf(rowOf({ state: "completed", reply: REPLY, completed_at: NINE })),
    ).toMatchObject({
      state: "completed",
      reply: { finish: "f", output: 1, spentUsd: 0 },
      completedAt: NINE,
    });
    expect(directMessageOf(rowOf())).not.toHaveProperty("reply");
  });
});
