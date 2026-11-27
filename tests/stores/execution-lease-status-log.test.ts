import { StatusTrigger, ThreadStatus, type ThreadStatusTransition } from "@agboss/core";
import { describe, expect, it } from "vitest";
import {
  appendRecordStatus,
  forgottenStatus,
  historyOf,
  recordTransitionOf,
  transitionOf,
  transitionOfRow,
} from "../../src/stores/status-log.js";
import { scriptedPool } from "./recorded-pool.js";

/**
 * The status history's rules and statements, with no database (agbossjs/agboss#1341d): which write is
 * a change, what made it, what a row reads as, and the writers of a thread ordered by an advisory
 * lock taken on its identity before anything is read or written.
 */
const THREAD = { tenantId: "acme", threadId: "thread-1" };
const AT = new Date("2026-01-05T09:00:00.000Z");
const lastOf = (toStatus: ThreadStatus, seq = 3): ThreadStatusTransition => ({
  ...THREAD,
  seq,
  fromStatus: null,
  toStatus,
  trigger: StatusTrigger.Start,
  at: AT,
});
const next = (toStatus: ThreadStatus, trigger = StatusTrigger.Start) => ({
  ...THREAD,
  toStatus,
  trigger,
});

describe("transitionOfRow", () => {
  const row = (fields: object) => ({
    tenant_id: "acme",
    thread_id: "thread-1",
    seq: 2,
    from_status: null,
    to_status: "running",
    trigger: "start",
    reason: null,
    actor: null,
    lease_token: null,
    at: AT,
    ...fields,
  });

  it("keeps the lease token, the reason and the actor a row has, and no key for one it has not", () => {
    const full = transitionOfRow(row({ lease_token: 7, reason: "why", actor: "ann" }));
    const bare = transitionOfRow(row({}));

    expect(full).toMatchObject({ leaseToken: 7, reason: "why", actor: "ann", seq: 2 });
    expect(bare).not.toHaveProperty("leaseToken");
    expect(bare).not.toHaveProperty("reason");
    expect(bare).not.toHaveProperty("actor");
  });
});

describe("transitionOf", () => {
  it("is none for a status the thread already has", () => {
    expect(
      transitionOf(next(ThreadStatus.Paused), lastOf(ThreadStatus.Paused), AT),
    ).toBeUndefined();
  });

  it.each([ThreadStatus.Stopping, ThreadStatus.Cancelling])(
    "a record running again while the thread is %s is no change",
    (ending) => {
      expect(transitionOf(next(ThreadStatus.Running), lastOf(ending), AT)).toBeUndefined();
    },
  );

  it("running after any other status, or another status after a stop under way, is a change", () => {
    const resumed = transitionOf(next(ThreadStatus.Running), lastOf(ThreadStatus.Paused), AT);
    const finished = transitionOf(next(ThreadStatus.Finished), lastOf(ThreadStatus.Stopping), AT);
    const first = transitionOf(next(ThreadStatus.Running), undefined, AT);

    expect(resumed).toMatchObject({
      seq: 4,
      fromStatus: ThreadStatus.Paused,
      toStatus: ThreadStatus.Running,
    });
    expect(finished).toMatchObject({ seq: 4, fromStatus: ThreadStatus.Stopping });
    expect(first).toMatchObject({ seq: 1, fromStatus: null, at: AT });
  });
});

describe("recordTransitionOf", () => {
  const made = (status: string, last?: ThreadStatusTransition) =>
    recordTransitionOf(THREAD, status, last, undefined);

  it.each([
    ["running", ThreadStatus.Running, StatusTrigger.Start],
    ["paused", ThreadStatus.Paused, StatusTrigger.Ask],
    ["answered", ThreadStatus.Finished, StatusTrigger.Finish],
    ["guarded", ThreadStatus.Finished, StatusTrigger.Finish],
    ["failed", ThreadStatus.Failed, StatusTrigger.Fail],
    ["stopped", ThreadStatus.Stopped, StatusTrigger.Stop],
    ["cancelled", ThreadStatus.Cancelled, StatusTrigger.Cancel],
  ])("a record %s makes the thread %s, by %s", (status, to, trigger) => {
    expect(made(status)).toMatchObject({ toStatus: to, trigger });
  });

  it("a record status that is no thread status makes none", () => {
    expect(made("queued")).toBeUndefined();
    expect(made("written")).toBeUndefined();
  });

  it("running again after a pause, of either kind, is a resume; after anything else, a start", () => {
    expect(made("running", lastOf(ThreadStatus.Paused))?.trigger).toBe(StatusTrigger.Resume);
    expect(made("running", lastOf(ThreadStatus.DualPaused))?.trigger).toBe(StatusTrigger.Resume);
    expect(made("running", lastOf(ThreadStatus.Finished))?.trigger).toBe(StatusTrigger.Start);
    expect(made("answered", lastOf(ThreadStatus.Paused))?.trigger).toBe(StatusTrigger.Finish);
  });

  it("a command's context says the status and the trigger, and the details it gave", () => {
    const told = recordTransitionOf(THREAD, "running", undefined, {
      toStatus: ThreadStatus.Cancelling,
      trigger: StatusTrigger.Cancel,
      reason: "r",
      actor: "ann",
      leaseToken: 4,
    });

    expect(told).toMatchObject({
      toStatus: ThreadStatus.Cancelling,
      trigger: StatusTrigger.Cancel,
      reason: "r",
      actor: "ann",
      leaseToken: 4,
    });
  });
});

describe("appendRecordStatus", () => {
  const INSERT = "INSERT INTO agboss_thread_status_transitions";

  it("takes the thread's advisory lock first, on its identity, then reads its last row and appends", async () => {
    const { pool, sent } = scriptedPool(() => undefined);
    const client = await pool.connect();

    await appendRecordStatus(client, THREAD, { status: "running", context: undefined, at: AT });

    const statements = sent.filter(({ sql }) => !/^(BEGIN|COMMIT)$/u.test(sql));
    expect(statements[0]).toEqual({
      sql: "SELECT pg_advisory_xact_lock(hashtextextended($1, 1341))",
      values: [JSON.stringify(["acme", "thread-1"])],
    });
    expect(statements.some(({ sql }) => sql.startsWith(INSERT))).toBe(true);
  });

  it("a record status that is no thread status writes nothing", async () => {
    const { pool, sent } = scriptedPool(() => undefined);
    const client = await pool.connect();

    await appendRecordStatus(client, THREAD, { status: "queued", context: undefined, at: AT });

    expect(sent.some(({ sql }) => sql.startsWith(INSERT))).toBe(false);
  });

  it("a repeat of the thread's status writes nothing, and the lock is taken again by the append", async () => {
    const last = {
      tenant_id: "acme",
      thread_id: "thread-1",
      seq: 1,
      from_status: null,
      to_status: "running",
      trigger: "start",
      reason: null,
      actor: null,
      lease_token: null,
      at: AT,
    };
    const { pool, sent } = scriptedPool((sql) => (sql.startsWith("SELECT *") ? [last] : undefined));
    const client = await pool.connect();

    await appendRecordStatus(client, THREAD, { status: "running", context: undefined, at: AT });

    expect(sent.some(({ sql }) => sql.startsWith(INSERT))).toBe(false);
    const locks = sent.filter(({ sql }) => sql.includes("pg_advisory_xact_lock"));
    expect(locks.map(({ values }) => values)).toEqual([
      [JSON.stringify(["acme", "thread-1"])],
      [JSON.stringify(["acme", "thread-1"])],
    ]);
  });
});

describe("the rows a status change writes and reads", () => {
  const insertOf = (sent: readonly { sql: string; values: readonly unknown[] }[]) =>
    sent.find(({ sql }) => sql.startsWith("INSERT INTO agboss_thread_status_transitions"));

  it("writes every column: the thread, the sequence, both statuses, the trigger, the details and the time", async () => {
    const { pool, sent } = scriptedPool(() => undefined);
    const client = await pool.connect();

    await appendRecordStatus(client, THREAD, {
      status: "paused",
      context: { reason: "why", actor: "ann", leaseToken: 7 },
      at: AT,
    });
    await appendRecordStatus(client, THREAD, { status: "running", context: undefined, at: AT });

    const [withDetails, bare] = sent.filter(({ sql }) =>
      sql.startsWith("INSERT INTO agboss_thread"),
    );
    expect(withDetails?.values).toEqual([
      "acme",
      "thread-1",
      1,
      null,
      "paused",
      "ask",
      "why",
      "ann",
      7,
      AT,
    ]);
    expect(bare?.values).toEqual([
      "acme",
      "thread-1",
      1,
      null,
      "running",
      "start",
      null,
      null,
      null,
      AT,
    ]);
    expect(insertOf(sent)).toBeDefined();
  });

  it("reads the last row of the thread by its tenant and id", async () => {
    const { pool, sent } = scriptedPool(() => undefined);
    const client = await pool.connect();

    await appendRecordStatus(client, THREAD, { status: "running", context: undefined, at: AT });

    const read = sent.find(({ sql }) =>
      sql.startsWith("SELECT * FROM agboss_thread_status_transitions"),
    );
    expect(read?.values).toEqual(["acme", "thread-1"]);
  });

  it("forgets a thread's history by its tenant and id, and reads it back oldest first", async () => {
    const row = {
      tenant_id: "acme",
      thread_id: "thread-1",
      seq: 1,
      from_status: null,
      to_status: "running",
      trigger: "start",
      reason: null,
      actor: null,
      lease_token: null,
      at: AT,
    };
    const { pool, sent } = scriptedPool((sql) => (sql.startsWith("SELECT *") ? [row] : undefined));
    const client = await pool.connect();

    await forgottenStatus(client, THREAD);
    const history = await historyOf(client, THREAD);

    const forgotten = sent.find(({ sql }) =>
      sql.startsWith("DELETE FROM agboss_thread_status_transitions"),
    );
    expect(forgotten?.sql).toBe(
      "DELETE FROM agboss_thread_status_transitions WHERE tenant_id = $1 AND thread_id = $2",
    );
    expect(forgotten?.values).toEqual(["acme", "thread-1"]);
    const read = sent.find(({ sql }) => sql.startsWith("SELECT *"));
    expect(read?.sql).toContain("ORDER BY seq");
    expect(read?.values).toEqual(["acme", "thread-1"]);
    expect(history).toEqual([expect.objectContaining({ seq: 1, toStatus: "running" })]);
  });
});
