import {
  InterruptMode,
  StatusTrigger,
  StoreClock,
  StoreTimeSource,
  ThreadStatus,
} from "@agboss/core";
import { ClusterLeaseSyncOutcome } from "@agboss/core/stores";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { checkCancel, markCancel } from "../../src/stores/cancel-fence.js";
import { markPause, markStop, pauseMarksOf } from "../../src/stores/lease-marks.js";
import { TestApplicationContext } from "../support/application-context.js";
import {
  scriptedConnection,
  scriptedPool,
  squeezed,
  type Respond,
  type Sent,
} from "./recorded-pool.js";

/**
 * The marks of a tree's lease row and the fences read from them, with no database (agbossjs/agboss
 * #1341b, #1341c, #909): what each statement is, in which order, with which parameters, and which
 * case writes a history row — on a pool that answers what the case says and records what it was sent.
 * What the database does with them is the contract suite's.
 */
const TREE = { tenantId: "acme", rootExecutionId: "run-1" };
const NOW = new Date("2026-01-05T09:00:00.000Z");
const AT = new Date("2026-01-05T09:00:01.000Z");
const TRANSITION = {
  tenantId: "acme",
  threadId: "thread-1",
  toStatus: ThreadStatus.Stopping,
  trigger: StatusTrigger.Stop,
};

const MARKS = {
  is_cancelled: false,
  stop_mode: null,
  is_externally_paused: false,
  external_pause_reason: null,
  external_pause_mode: null,
  fenced_through_token: null,
};
const isMarksRead = (sql: string): boolean =>
  sql.startsWith("SELECT cancel_requested_at IS NOT NULL AS is_cancelled");
const marksAre =
  (fields: object | undefined): Respond =>
  (sql) =>
    isMarksRead(sql) && fields !== undefined ? [{ ...MARKS, ...fields }] : undefined;
const wrote = (sent: readonly Sent[], what: string): boolean =>
  sent.some(({ sql }) => sql.includes(what));
const STATUS_ROW = "INSERT INTO agboss_thread_status_transitions";

describe("markStop", () => {
  const stopWith = async (before: string | undefined, mode: InterruptMode) => {
    const { pool, sent } = scriptedPool(
      marksAre(before === undefined ? undefined : { stop_mode: before }),
    );
    const client = await pool.connect();
    await markStop(client, TREE, { now: NOW, at: AT, mode, transition: TRANSITION });
    return sent;
  };

  it("seeds the row, locks it FOR UPDATE for the read, then writes the stop and its history row", async () => {
    const sent = await stopWith(undefined, InterruptMode.AfterStep);

    const statements = sent.filter(({ sql }) => !/^(BEGIN|COMMIT)$/u.test(sql));
    expect(statements[0]?.sql).toContain("INSERT INTO agboss_execution_leases");
    expect(statements[0]?.values).toEqual(["acme", "run-1", NOW]);
    expect(squeezed(statements[1]?.sql ?? "")).toMatch(
      /WHERE tenant_id = \$1 AND root_execution_id = \$2 FOR UPDATE$/u,
    );
    expect(statements[1]?.values).toEqual(["acme", "run-1"]);
    const stop = sent.find(({ sql }) => sql.includes("stop_requested_at, stop_mode)"));
    expect(stop?.values).toEqual(["acme", "run-1", NOW, InterruptMode.AfterStep]);
    expect(wrote(sent, STATUS_ROW)).toBe(true);
  });

  it.each([
    ["no stop yet, after-step", undefined, InterruptMode.AfterStep, true],
    ["no stop yet, immediate", undefined, InterruptMode.Immediate, true],
    ["after-step, escalated to immediate", InterruptMode.AfterStep, InterruptMode.Immediate, true],
    ["after-step, repeated", InterruptMode.AfterStep, InterruptMode.AfterStep, false],
    ["immediate, repeated", InterruptMode.Immediate, InterruptMode.Immediate, false],
    [
      "immediate, asked after-step: never lowered",
      InterruptMode.Immediate,
      InterruptMode.AfterStep,
      false,
    ],
  ])("%s: the stop is written %s", async (_name, before, mode, isWritten) => {
    const sent = await stopWith(before, mode);

    expect(wrote(sent, "stop_requested_at, stop_mode)")).toBe(isWritten);
    expect(wrote(sent, STATUS_ROW)).toBe(isWritten);
  });

  it("with no transition given no history row is written", async () => {
    const { pool, sent } = scriptedPool(marksAre(undefined));
    const client = await pool.connect();

    await markStop(client, TREE, { now: NOW, at: AT, mode: InterruptMode.Immediate });

    expect(wrote(sent, "stop_requested_at, stop_mode)")).toBe(true);
    expect(wrote(sent, STATUS_ROW)).toBe(false);
  });
});

describe("markPause", () => {
  const pauseWith = async (marks: object | undefined) => {
    const { pool, sent } = scriptedPool(marksAre(marks));
    const client = await pool.connect();
    await markPause(client, TREE, {
      now: NOW,
      at: AT,
      transition: TRANSITION,
      request: { mode: InterruptMode.Immediate, reason: "why" },
    });
    return sent;
  };

  it("locks the row FOR UPDATE for the read and writes the pause with its mode, reason and fence", async () => {
    const sent = await pauseWith({});

    const read = sent.find(({ sql }) => isMarksRead(sql));
    expect(squeezed(read?.sql ?? "")).toMatch(/FOR UPDATE$/u);
    const pause = sent.find(({ sql }) =>
      sql.includes("is_externally_paused, external_pause_reason"),
    );
    expect(pause?.values).toEqual(["acme", "run-1", NOW, "why", 0, InterruptMode.Immediate, true]);
  });

  it("an after-step pause with no reason writes the mode, no reason and no fence", async () => {
    const { pool, sent } = scriptedPool(marksAre(undefined));
    const client = await pool.connect();

    await markPause(client, TREE, { now: NOW, at: AT, request: { mode: InterruptMode.AfterStep } });

    const pause = sent.find(({ sql }) =>
      sql.includes("is_externally_paused, external_pause_reason"),
    );
    expect(pause?.values).toEqual([
      "acme",
      "run-1",
      NOW,
      null,
      null,
      InterruptMode.AfterStep,
      false,
    ]);
  });

  it.each([
    ["a tree not paused yet", { is_externally_paused: false }, true],
    ["a tree with no row", undefined, true],
    ["a tree already paused", { is_externally_paused: true }, false],
  ])("%s: the history row is written %s", async (_name, marks, isLogged) => {
    const sent = await pauseWith(marks);

    expect(wrote(sent, STATUS_ROW)).toBe(isLogged);
  });
});

describe("pauseMarksOf", () => {
  const marksOf = async (marks: object) => {
    const { pool } = scriptedPool(marksAre(marks));
    const client = await pool.connect();
    return pauseMarksOf(client, TREE);
  };

  it("names the pause and the fence a row has, each only when it has it", async () => {
    expect(
      await marksOf({
        is_externally_paused: true,
        external_pause_reason: "why",
        external_pause_mode: "immediate",
        fenced_through_token: 5,
      }),
    ).toStrictEqual({
      pause: { reason: "why", mode: InterruptMode.Immediate },
      fencedThroughToken: 5,
    });
    expect(
      await marksOf({ is_externally_paused: true, external_pause_mode: "after-step" }),
    ).toStrictEqual({
      pause: { mode: InterruptMode.AfterStep },
    });
    expect(await marksOf({ fenced_through_token: 2 })).toStrictEqual({ fencedThroughToken: 2 });
    expect(await marksOf({})).toStrictEqual({});
  });
});

describe("markCancel", () => {
  const cancelWith = async (wasMarked: boolean, transition: typeof TRANSITION | undefined) => {
    const { pool, sent } = scriptedPool((sql) =>
      sql.startsWith("SELECT 1 FROM agboss_execution_leases") && wasMarked
        ? [{ "?column?": 1 }]
        : undefined,
    );
    const client = await pool.connect();
    await markCancel(client, TREE, { now: NOW, at: AT, transition });
    return sent;
  };

  it("seeds, then reads whether the cancel is marked FOR UPDATE, then marks", async () => {
    const sent = await cancelWith(false, TRANSITION);

    const statements = sent.filter(({ sql }) => !/^(BEGIN|COMMIT)$/u.test(sql));
    expect(statements[0]?.sql).toContain("INSERT INTO agboss_execution_leases");
    expect(squeezed(statements[1]?.sql ?? "")).toBe(
      "SELECT 1 FROM agboss_execution_leases WHERE tenant_id = $1 AND root_execution_id = $2 AND cancel_requested_at IS NOT NULL FOR UPDATE",
    );
    expect(statements[1]?.values).toEqual(["acme", "run-1"]);
    expect(statements[2]?.sql).toContain("cancel_requested_at = COALESCE");
    expect(statements[2]?.values).toEqual(["acme", "run-1", NOW]);
  });

  it("the history row is written only when this call set the mark, and only when a transition was given", async () => {
    expect(wrote(await cancelWith(false, TRANSITION), STATUS_ROW)).toBe(true);
    expect(wrote(await cancelWith(true, TRANSITION), STATUS_ROW)).toBe(false);
    expect(wrote(await cancelWith(false, undefined), STATUS_ROW)).toBe(false);
  });
});

describe("checkCancel's pause fence", () => {
  const keyOf = (leaseExecutionId: string, token: number) =>
    effectKeyForTesting({
      scopeKey: `acme:${leaseExecutionId}`,
      tenantId: "acme",
      leaseExecutionId,
      rootExecutionId: "run-1",
      token,
      idempotencyKey: `${leaseExecutionId}:charge:1`,
      name: "charge",
    });
  const checked = async (
    key: ReturnType<typeof keyOf>,
    row: { fenced: number | null; token: number },
  ) => {
    const { pool } = scriptedPool((sql) =>
      sql.includes("FOR SHARE")
        ? [
            {
              is_cancelled: false,
              stop_mode: null,
              fenced_through_token: row.fenced,
              token: row.token,
            },
          ]
        : undefined,
    );
    const client = await pool.connect();
    return checkCancel(client, key, NOW).then(
      () => "passed",
      (error: unknown) => String(error),
    );
  };

  it("the root's own write at or below the fence is stale, whatever the row's token now is", async () => {
    expect(await checked(keyOf("run-1", 1), { fenced: 2, token: 3 })).not.toBe("passed");
    expect(await checked(keyOf("run-1", 2), { fenced: 2, token: 3 })).not.toBe("passed");
    expect(await checked(keyOf("run-1", 3), { fenced: 2, token: 3 })).toBe("passed");
  });

  it("a child's write is stale while the root's current token is the fenced one or below", async () => {
    expect(await checked(keyOf("run-1/child/a", 9), { fenced: 2, token: 2 })).not.toBe("passed");
    expect(await checked(keyOf("run-1/child/a", 1), { fenced: 2, token: 3 })).toBe("passed");
  });

  it("no fence, no staleness", async () => {
    expect(await checked(keyOf("run-1", 1), { fenced: null, token: 3 })).toBe("passed");
  });
});

describe("checkCancel's stop and cancel fences", () => {
  const checkedWith = async (
    row: { is_cancelled: boolean; stop_mode: string | null },
    fields: object = {},
  ) => {
    const { pool, sent } = scriptedPool((sql) =>
      sql.includes("FOR SHARE") ? [{ ...row, fenced_through_token: null, token: 1 }] : undefined,
    );
    const client = await pool.connect();
    const key = effectKeyForTesting(
      {
        scopeKey: "acme:run-1",
        tenantId: "acme",
        leaseExecutionId: "run-1",
        token: 1,
        idempotencyKey: "run-1:charge:1",
        name: "charge",
      },
      fields,
    );
    const outcome = await checkCancel(client, key, NOW).then(
      () => "passed",
      (error: unknown) => String(error),
    );
    return { outcome, sent };
  };

  it("reads the root's row by tenant and root, locked FOR SHARE, after seeding it", async () => {
    const { sent } = await checkedWith({ is_cancelled: false, stop_mode: null });

    const statements = sent.filter(({ sql }) => !/^(BEGIN|COMMIT)$/u.test(sql));
    expect(statements[0]?.sql).toContain("INSERT INTO agboss_execution_leases");
    expect(statements[1]?.values).toEqual(["acme", "run-1"]);
    expect(statements[1]?.sql).toContain("FOR SHARE");
  });

  it("an immediate stop with no cancel fences the write; an after-step one does not", async () => {
    expect((await checkedWith({ is_cancelled: false, stop_mode: "immediate" })).outcome).not.toBe(
      "passed",
    );
    expect((await checkedWith({ is_cancelled: false, stop_mode: "after-step" })).outcome).toBe(
      "passed",
    );
    expect((await checkedWith({ is_cancelled: false, stop_mode: null })).outcome).toBe("passed");
  });

  it("a cancel fences the write, but not an undo's (a compensation)", async () => {
    expect((await checkedWith({ is_cancelled: true, stop_mode: null })).outcome).not.toBe("passed");
    expect(
      (await checkedWith({ is_cancelled: true, stop_mode: null }, { isCompensation: true }))
        .outcome,
    ).toBe("passed");
    expect(
      (await checkedWith({ is_cancelled: false, stop_mode: null }, { isCompensation: true }))
        .outcome,
    ).toBe("passed");
  });
});

describe("the lease store's cluster mirror and cancel", () => {
  const storeOn = (respond: Respond) => {
    const { connection, sent } = scriptedConnection(respond);
    const store = new PostgresExecutionLeaseRepository(
      connection,
      new StoreClock(StoreTimeSource.Test, new VirtualClock()),
      new TestApplicationContext(),
    );
    return { store, sent };
  };
  const LEASE = {
    tenantId: "acme",
    rootExecutionId: "run-1",
    holderInstanceId: "pod-1",
    token: 4,
    expiresAt: NOW,
    remaining: 1000,
  } as never;

  it.each([
    [undefined, false],
    [{}, false],
    [{ isReclaim: false }, false],
    [{ isReclaim: true }, true],
  ])("a sync with take %j passes isReclaim %s to the upsert", async (take, isReclaim) => {
    const { store, sent } = storeOn((sql) =>
      sql.startsWith("INSERT INTO agboss_execution_leases AS lease") ? [{}] : undefined,
    );

    const synced = await store.syncClusterLease(LEASE, take);

    expect(synced).toEqual({ outcome: ClusterLeaseSyncOutcome.Synced });
    expect(
      sent.find(({ sql }) => sql.includes("holder_instance_id = EXCLUDED.holder_instance_id"))
        ?.values[5],
    ).toBe(isReclaim);
  });

  const mirror =
    (row: object | undefined): Respond =>
    (sql) =>
      sql.startsWith("SELECT holder_instance_id, token, released, finished") && row !== undefined
        ? [row]
        : undefined;

  it("a sync that wrote no row reads the mirror: retired, behind with the row's token, or behind with its own when there is none", async () => {
    const retired = await storeOn(
      mirror({ holder_instance_id: "x", token: 9, released: true, finished: true }),
    ).store.syncClusterLease(LEASE);
    const behind = await storeOn(
      mirror({ holder_instance_id: "x", token: 9, released: false, finished: false }),
    ).store.syncClusterLease(LEASE);
    const none = await storeOn(mirror(undefined)).store.syncClusterLease(LEASE);

    expect(retired).toEqual({ outcome: ClusterLeaseSyncOutcome.Retired });
    expect(behind).toEqual({ outcome: ClusterLeaseSyncOutcome.Behind, rowToken: 9 });
    expect(none).toEqual({ outcome: ClusterLeaseSyncOutcome.Behind, rowToken: 4 });
  });

  it("requestCancel marks the cancel with the clock's time and the transition it was given", async () => {
    const { store, sent } = storeOn(() => undefined);

    await store.requestCancel({ tenantId: "acme", rootExecutionId: "run-1" }, TRANSITION);

    const seed = sent.find(({ sql }) => sql.includes("INSERT INTO agboss_execution_leases"));
    expect(seed?.values[2]).toBeInstanceOf(Date);
    expect(wrote(sent, STATUS_ROW)).toBe(true);
  });
});
