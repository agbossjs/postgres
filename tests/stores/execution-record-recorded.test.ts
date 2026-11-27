import { ExecutionRecordStatus } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { deleteIdleThreads } from "../../src/stores/records/record-idle.js";
import { claimExisting } from "../../src/stores/records/record-writes.js";
import { completeUnlessInterrupted } from "../../src/stores/records/record-interrupt.js";
import { outcomeOf } from "../support/stores.js";
import { recordedPool, squeezed, type Sent } from "./recorded-pool.js";

/**
 * The statements of the finish that must not land over a stop or cancel mark, and of the sweep of
 * idle threads (agbossjs/agboss#1341b, #1303c), on a pool that answers what each case says and
 * records what it was sent — no database. What the database does with them is the contract suite's.
 */
const NOW = new Date("2026-01-05T09:00:00.000Z");
const OUTCOME = outcomeOf(ExecutionRecordStatus.Answered);
const READ = "SELECT tenant_id, run_id FROM agboss_execution_records WHERE id = $1";

const inTransaction = (sent: readonly Sent[]): readonly Sent[] =>
  sent.filter(({ sql }) => !/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql));
const leaseStatements = (sent: readonly Sent[]): readonly Sent[] =>
  sent.filter(({ sql }) => sql.includes("agboss_execution_leases"));
const completions = (sent: readonly Sent[]): readonly Sent[] =>
  sent.filter(({ sql }) => sql.startsWith("UPDATE agboss_execution_records SET reply_with"));

describe("completeUnlessInterrupted", () => {
  it("reads the record's tree by its id, and a record that is none is completed as a plain finish", async () => {
    const { pool, sent } = recordedPool([[]]);

    const written = await completeUnlessInterrupted(pool, "turn-1", OUTCOME, { now: NOW });

    expect(inTransaction(sent)[0]).toEqual({ sql: READ, values: ["turn-1"] });
    expect(leaseStatements(sent)).toEqual([]);
    expect(completions(sent)).toHaveLength(1);
    expect(written).toBe(false);
  });

  it("a record that belongs to no run looks at no marks", async () => {
    const { pool, sent } = recordedPool([[{ tenant_id: "default", run_id: null }]]);

    await completeUnlessInterrupted(pool, "turn-1", OUTCOME, { now: NOW });

    expect(leaseStatements(sent)).toEqual([]);
    expect(completions(sent)).toHaveLength(1);
  });

  it("a record of a run seeds the tree's row, then reads its marks FOR SHARE, and goes on when none is set", async () => {
    const { pool, sent } = recordedPool([
      [{ tenant_id: "acme", run_id: "run-7" }],
      [],
      [{ is_interrupted: false }],
      [{ tenant_id: "acme", thread_id: "thread-1" }],
    ]);

    const written = await completeUnlessInterrupted(pool, "turn-1", OUTCOME, { now: NOW });

    const [seed, marks] = leaseStatements(sent);
    expect(seed?.sql).toContain("INSERT INTO agboss_execution_leases");
    expect(seed?.values).toEqual(["acme", "run-7", NOW]);
    expect(squeezed(marks?.sql ?? "")).toBe(
      "SELECT cancel_requested_at IS NOT NULL OR stop_mode IS NOT NULL AS is_interrupted FROM agboss_execution_leases WHERE tenant_id = $1 AND root_execution_id = $2 FOR SHARE",
    );
    expect(marks?.values).toEqual(["acme", "run-7"]);
    expect(completions(sent)).toHaveLength(1);
    expect(written).toBe(true);
  });

  it("a tree whose row has no marks to read (none came back) is not interrupted", async () => {
    const { pool, sent } = recordedPool([[{ tenant_id: "acme", run_id: "run-7" }], [], []]);

    await completeUnlessInterrupted(pool, "turn-1", OUTCOME, { now: NOW });

    expect(completions(sent)).toHaveLength(1);
  });

  it("a stop or cancel mark refuses the finish: nothing is written", async () => {
    const { pool, sent } = recordedPool([
      [{ tenant_id: "acme", run_id: "run-7" }],
      [],
      [{ is_interrupted: true }],
    ]);

    const written = await completeUnlessInterrupted(pool, "turn-1", OUTCOME, { now: NOW });

    expect(written).toBe(false);
    expect(completions(sent)).toEqual([]);
    expect(sent.at(-1)?.sql).toBe("COMMIT");
  });

  it("rows that are not what the statements select are refused", async () => {
    await expect(
      completeUnlessInterrupted(recordedPool([[{ tenant_id: 7 }]]).pool, "t", OUTCOME, {
        now: NOW,
      }),
    ).rejects.toThrow();
    await expect(
      completeUnlessInterrupted(
        recordedPool([[{ tenant_id: "acme", run_id: "run-7" }], [], [{ is_interrupted: "yes" }]])
          .pool,
        "t",
        OUTCOME,
        { now: NOW },
      ),
    ).rejects.toThrow();
  });
});

describe("deleteIdleThreads", () => {
  const CUTOFF = new Date("2026-01-01T00:00:00.000Z");

  it("removes a thread no live record holds: the scores first, the live statuses named, then the rest", async () => {
    const { pool, sent } = recordedPool([
      [{ tenant_id: "acme", id: "thread-1" }],
      [{ run_id: "run-1" }],
      [{ "?column?": 1 }],
    ]);

    const removed = await deleteIdleThreads(pool, new Map([["desk-workflow", CUTOFF]]), () =>
      Promise.resolve(true),
    );

    expect(removed).toBe(1);
    const still = sent.find(({ sql }) => sql.includes("FOR UPDATE OF t"));
    expect(still?.values).toEqual([
      "acme",
      "thread-1",
      "desk-workflow",
      CUTOFF,
      ["running", "paused", "queued"],
      ["run-1"],
    ]);
    const scores = sent.find(({ sql }) => sql.includes("DELETE FROM agboss_execution_scores"));
    expect(squeezed(scores?.sql ?? "")).toBe(
      "DELETE FROM agboss_execution_scores WHERE record_id IN (SELECT id FROM agboss_execution_records WHERE tenant_id = $1 AND thread_id = $2)",
    );
    expect(scores?.values).toEqual(["acme", "thread-1"]);
  });

  it("a thread a live record came back to is kept: nothing of it is deleted", async () => {
    const { pool, sent } = recordedPool([
      [{ tenant_id: "acme", id: "thread-1" }],
      [{ run_id: "run-1" }],
      [],
    ]);

    const removed = await deleteIdleThreads(pool, new Map([["desk-workflow", CUTOFF]]), () =>
      Promise.resolve(true),
    );

    expect(removed).toBe(0);
    expect(sent.some(({ sql }) => sql.startsWith("DELETE"))).toBe(false);
  });

  it("a thread with a run that has not ended is kept, asked once per run", async () => {
    const asked: string[] = [];
    const { pool, sent } = recordedPool([
      [{ tenant_id: "acme", id: "thread-1" }],
      [{ run_id: "run-1" }, { run_id: "run-2" }],
    ]);

    const removed = await deleteIdleThreads(pool, new Map([["desk-workflow", CUTOFF]]), (tree) => {
      asked.push(tree.rootExecutionId);
      return Promise.resolve(false);
    });

    expect(removed).toBe(0);
    expect(asked).toEqual(["run-1"]);
    expect(sent.some(({ sql }) => sql.includes("FOR UPDATE OF t"))).toBe(false);
  });
});

describe("claimExisting", () => {
  const claim = { tenantId: "acme", threadId: "thread-1", ownerId: "ann" };
  const updates = (sent: readonly Sent[]): readonly Sent[] =>
    sent.filter(({ sql }) => sql.startsWith("UPDATE agboss_threads"));

  it("a thread that is none, or one that is not swept, is left as it is", async () => {
    const none = recordedPool([[]]);
    const live = recordedPool([[{ owner: "ann", is_swept: false }]]);

    await claimExisting(none.pool, claim, NOW);
    await claimExisting(live.pool, claim, NOW);

    expect(updates(none.sent)).toEqual([]);
    expect(updates(live.sent)).toEqual([]);
  });

  it("a swept thread its owner asks for again is revived at the time given", async () => {
    const { pool, sent } = recordedPool([[{ owner: "ann", is_swept: true }]]);

    await claimExisting(pool, claim, NOW);

    expect(updates(sent).map(({ values }) => values)).toEqual([["acme", "thread-1", NOW]]);
  });

  it("a swept thread of another owner is not created again", async () => {
    const { pool, sent } = recordedPool([[{ owner: "bob", is_swept: true }]]);

    await expect(claimExisting(pool, claim, NOW)).rejects.toThrow("another owner");

    expect(updates(sent)).toEqual([]);
  });
});
