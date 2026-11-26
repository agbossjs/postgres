import { PauseNoticeKind, PauseRespondent, seenOf, type PauseSeen } from "@agboss/core/stores";
import type { PauseRecord } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { markSentNotices, type PlannedNotice } from "../../src/stores/paused/pause-notice-plan.js";
import { reassignPlan } from "../../src/stores/paused/pause-reassign-plan.js";
import { timeoutChangePlan } from "../../src/stores/paused/pause-timer-plan.js";
import { mailboxRowOf } from "../../src/stores/paused/pause-notice-rows.js";
import { DEADLINE, MID, NINE, RECIPIENTS, expiringPauseOf, pauseOf } from "./pause-fixtures.js";

/**
 * What a change of a pause makes of the record the store read under its row lock (agbossjs/agboss#1307):
 * pure, so none of it needs a database. The statements that write the plan are the contract suite's.
 */
const FROM = DEADLINE.toISOString();
const LATER = "2026-01-05T12:00:00.000Z";
const EARLIER = "2026-01-05T09:50:00.000Z";
const CAP = "2026-01-05T20:00:00.000Z";
const NONE = { listeners: [] };

/** The pause with the limits a target opened it under. */
const limited = (limits: Partial<PauseRecord> = {}): PauseRecord => ({
  ...expiringPauseOf("p"),
  // what the channel is asked with: the `opened` entry carries the deadline
  trail: pauseOf("p").trail.map((entry) => ({ ...entry, expiresAt: FROM })),
  maxExpiresAt: CAP,
  escalationLimits: { maxExtensions: 2, maxReassignments: 2 },
  ...limits,
});

const changeOf = (pause: PauseRecord, fields: object) => ({
  seen: seenOf(pause),
  ...fields,
});

describe("a deadline change", () => {
  it("shortens, sets over none and takes away, each over the deadline the caller read", () => {
    const pause = limited();
    const shorter = timeoutChangePlan(
      pause,
      changeOf(pause, { expiresAt: EARLIER, previousExpiresAt: FROM }),
      MID,
      NONE,
    );
    expect(shorter?.pause.expiresAt).toBe(EARLIER);

    const none = limited({ expiresAt: undefined, remindAt: undefined, maxExpiresAt: undefined });
    expect(
      timeoutChangePlan(none, changeOf(none, { expiresAt: LATER }), MID, NONE)?.pause.expiresAt,
    ).toBe(LATER);
    expect(
      timeoutChangePlan(
        none,
        changeOf(none, { expiresAt: LATER, previousExpiresAt: FROM }),
        MID,
        NONE,
      ),
    ).toBeUndefined();

    const uncapped = limited({ maxExpiresAt: undefined });
    const taken = timeoutChangePlan(
      uncapped,
      changeOf(uncapped, { previousExpiresAt: FROM }),
      MID,
      NONE,
    );
    expect(taken?.pause.expiresAt).toBeUndefined();
    expect(taken?.pause.trail.at(-1)).not.toHaveProperty("expiresAt");
  });

  it("is refused to the moment or the past, over a stale deadline or a pause that changed since", () => {
    const pause = limited();
    const plan = (fields: object, read: PauseRecord = pause, at = MID) =>
      timeoutChangePlan(read, changeOf(pause, fields), at, NONE);

    expect(plan({ expiresAt: MID.toISOString(), previousExpiresAt: FROM })).toBeUndefined();
    expect(plan({ expiresAt: NINE.toISOString(), previousExpiresAt: FROM })).toBeUndefined();
    expect(plan({ expiresAt: LATER, previousExpiresAt: EARLIER })).toBeUndefined();
    expect(plan({ expiresAt: LATER })).toBeUndefined();
    // the pause read now has one more entry than the one the change was planned over
    const changed = { ...pause, trail: [...pause.trail, ...pause.trail] };
    expect(plan({ expiresAt: LATER, previousExpiresAt: FROM }, changed)).toBeUndefined();
    expect(
      plan({ expiresAt: LATER, previousExpiresAt: FROM }, { ...pause, isSent: true }),
    ).toBeUndefined();
    // a pause already past its deadline takes none
    expect(plan({ expiresAt: LATER, previousExpiresAt: FROM }, pause, DEADLINE)).toBeUndefined();
    expect(plan({ expiresAt: LATER, previousExpiresAt: FROM })).toBeDefined();
  });

  it("keeps the record's cap and its count, whatever the change carries", () => {
    const pause = limited({ escalationLimits: { maxExtensions: 1 } });
    const plan = (read: PauseRecord, fields: object) =>
      timeoutChangePlan(read, changeOf(read, fields), MID, NONE);

    expect(
      plan(pause, { expiresAt: "2026-01-05T20:00:00.001Z", previousExpiresAt: FROM }),
    ).toBeUndefined();
    expect(plan(pause, { previousExpiresAt: FROM })).toBeUndefined();
    const once = plan(pause, { expiresAt: CAP, previousExpiresAt: FROM, maxExtensions: 99 });
    expect(once?.pause.expiresAt).toBe(CAP);
    // the chain now holds the one change the record's limit allows
    const after = once?.pause;
    if (after === undefined) throw new Error("the first change applies");
    expect(
      plan(after, { expiresAt: EARLIER, previousExpiresAt: CAP, maxExtensions: 99 }),
    ).toBeUndefined();
    // no limit named: no count reaches it
    const free = limited({ escalationLimits: {}, maxExpiresAt: undefined });
    expect(plan(free, { expiresAt: LATER, previousExpiresAt: FROM })).toBeDefined();
  });

  it("writes who and why into the entry and the notice, each fact only when there is one", () => {
    const pause = limited();
    const plan = timeoutChangePlan(
      pause,
      changeOf(pause, {
        expiresAt: EARLIER,
        previousExpiresAt: FROM,
        actor: { id: "manager-17" },
        reason: "escalated",
      }),
      MID,
      RECIPIENTS,
    );

    expect(plan?.pause.trail.at(-1)).toMatchObject({
      action: "timeout-changed",
      actor: { id: "manager-17" },
      expiresAt: EARLIER,
      reason: "escalated",
    });
    const notice = plan?.notices[0]?.notice;
    expect(notice).toMatchObject({
      kind: PauseNoticeKind.TimeoutChanged,
      expiresAt: EARLIER,
      previousExpiresAt: FROM,
      actor: { id: "manager-17" },
      changeReason: "escalated",
    });
    const bare = timeoutChangePlan(
      limited({ maxExpiresAt: undefined }),
      changeOf(pause, { previousExpiresAt: FROM }),
      MID,
      RECIPIENTS,
    );
    expect(JSON.stringify(bare?.notices[0]?.notice)).not.toMatch(/expiresAt"|actor|changeReason/u);
    expect(bare?.notices[0]?.notice).toMatchObject({ previousExpiresAt: FROM });
  });
});

const TO = {
  target: "other-target",
  respondent: PauseRespondent.Delegate,
  channel: "other-channel",
};

describe("a reassignment", () => {
  const plan = (
    pause: PauseRecord,
    change: object,
    at = MID,
    seen: PauseSeen | null = seenOf(pause),
  ) =>
    reassignPlan(
      pause,
      { ...change, ...(seen === null ? {} : { seen }) } as never,
      new Set(),
      at,
      RECIPIENTS,
    );

  it("applies to nothing without `seen`, or over a pause that changed since", () => {
    const pause = limited();

    expect(plan(pause, { assignees: ["x"] }, MID, null)).toBeUndefined();
    expect(plan(pause, { pauseId: "q", assignees: ["x"] }, MID, null)).toBeUndefined();
    expect(
      plan(pause, { assignees: ["x"] }, MID, { ...seenOf(pause), isSent: true }),
    ).toBeUndefined();
    expect(plan(pause, { assignees: ["x"] })?.pause.assignees).toEqual(["x"]);
  });

  it("counts against the record's limits narrowed by the destination, never the change's", () => {
    const pause = limited({ escalationLimits: { maxReassignments: 3, maxExtensions: 3 } });
    const one = plan(pause, { assignees: ["x"] })?.pause;
    if (one === undefined) throw new Error("the first reassignment applies");
    const offer = (limits: object) => ({ pauseId: "q", to: { ...TO, limits } });

    // the chain holds one reassignment: a destination that allows one refuses the move, one that allows two takes it
    expect(plan(one, offer({ escalationLimits: { maxReassignments: 1 } }))).toBeUndefined();
    const taken = plan(one, offer({ escalationLimits: { maxReassignments: 2 } }));
    expect(taken?.inserted?.escalationLimits).toEqual({ maxReassignments: 2, maxExtensions: 3 });
    // a looser destination frees nothing
    expect(
      plan(one, offer({ maxExpiresAt: "2026-01-06T00:00:00.000Z" }))?.inserted?.maxExpiresAt,
    ).toBe(CAP);
    expect(plan(one, offer({ maxExpiresAt: LATER }))?.inserted?.maxExpiresAt).toBe(LATER);
    // the old fields of the change are no limit
    expect(plan(one, { assignees: ["y"], maxReassignments: 1 })).toBeDefined();
  });

  it("keeps the cap on a deadline it sets, in place or narrowed by the destination, and an expiry's too", () => {
    const pause = limited();

    expect(
      plan(pause, { assignees: ["x"], timeout: { expiresAt: "2026-01-05T20:00:00.001Z" } }),
    ).toBeUndefined();
    expect(plan(pause, { assignees: ["x"], timeout: { expiresAt: CAP } })?.pause.expiresAt).toBe(
      CAP,
    );
    const move = { pauseId: "q", to: { ...TO, limits: { maxExpiresAt: LATER } } };
    expect(plan(pause, { ...move, timeout: { expiresAt: CAP } })).toBeUndefined();
    expect(plan(pause, { ...move, timeout: { expiresAt: LATER } })?.inserted?.maxExpiresAt).toBe(
      LATER,
    );
    // an expiry's reassignment that sets no deadline under a cap
    expect(
      plan(pause, { assignees: ["x"], due: {} }, new Date(DEADLINE.getTime() + 1)),
    ).toBeUndefined();
    expect(
      plan(pause, { assignees: ["x"], due: { expiresAt: CAP } }, new Date(DEADLINE.getTime() + 1)),
    ).toBeDefined();
  });

  it("spends an extension when the call sets a deadline: a `timeout-changed` entry after the `reassigned` one, on a replacement too", () => {
    const pause = limited({ escalationLimits: { maxExtensions: 1 } });
    const made = plan(pause, {
      pauseId: "q",
      to: TO,
      timeout: { expiresAt: LATER },
      countsAsExtension: true,
    });

    expect(made?.inserted?.trail.slice(-2).map((entry) => entry.action)).toEqual([
      "reassigned",
      "timeout-changed",
    ]);
    const spent = made?.inserted;
    if (spent === undefined) throw new Error("the replacement is made");
    expect(
      plan(
        { ...spent, isSent: false },
        { assignees: ["z"], timeout: { expiresAt: CAP }, countsAsExtension: true },
      ),
    ).toBeUndefined();
    // a change in place narrows nothing and a replacement that stays keeps the limits
    expect(plan(pause, { assignees: ["x"] })?.pause).toMatchObject({
      maxExpiresAt: CAP,
      escalationLimits: { maxExtensions: 1 },
    });
    expect(plan(pause, { pauseId: "q", to: TO })?.inserted?.firstAskedAt).toBe(pause.firstAskedAt);
  });
});

const kinds = (notices: readonly PlannedNotice[], recipient: string): string[] =>
  notices.filter((one) => one.recipient === recipient).map((one) => one.notice.kind);

describe("the notices of the first send", () => {
  it("a pause changed in place meanwhile: `opened` with the deadline the channel was asked with, then `reassigned` to the channel and the listeners", () => {
    const asked = limited();
    const moved = plan(
      asked,
      { assignees: ["deputy"], due: { expiresAt: LATER } },
      new Date(DEADLINE.getTime() + 1),
    );
    const pause = moved?.pause;
    if (pause === undefined) throw new Error("the in-place change applies");

    const notices = markSentNotices(pause, { ...pause, isSent: true }, RECIPIENTS);

    expect(kinds(notices, "channel:refund-approval-channel")).toEqual(["reassigned"]);
    expect(kinds(notices, "listener:audit-listener")).toEqual(["opened", "reassigned"]);
    const opened = notices.find((one) => one.notice.kind === PauseNoticeKind.Opened)?.notice;
    expect(opened).toMatchObject({ expiresAt: FROM });
    const reassigned = notices.find((one) => one.notice.kind === PauseNoticeKind.Reassigned);
    expect(reassigned?.notice).toMatchObject({
      expiresAt: LATER,
      previousExpiresAt: FROM,
      assignees: ["deputy"],
      previousTarget: "refund-tool-approval",
      previousChannel: "refund-approval-channel",
    });
    expect(reassigned?.at).toEqual(new Date(DEADLINE.getTime() + 1));
  });

  it("a pause nobody changed tells `opened` only, and a replacement `reassigned` to its listeners", () => {
    const pause = pauseOf("plain");
    expect(
      kinds(
        markSentNotices(pause, { ...pause, isSent: true }, RECIPIENTS),
        "listener:audit-listener",
      ),
    ).toEqual(["opened"]);
    const replaced = plan(limited(), { pauseId: "q", to: TO })?.inserted;
    if (replaced === undefined) throw new Error("the replacement is made");
    const notices = markSentNotices(replaced, { ...replaced, isSent: true }, RECIPIENTS);
    expect(kinds(notices, "channel:refund-approval-channel")).toEqual([]);
    expect(kinds(notices, "listener:audit-listener")).toEqual(["reassigned"]);
  });

  function plan(pause: PauseRecord, change: object, at = MID) {
    return reassignPlan(pause, { ...change, seen: seenOf(pause) }, new Set(), at, RECIPIENTS);
  }
});

describe("the mailbox row of a timeout change", () => {
  it("keeps the actor and the masked reason the notice was written with", () => {
    const stored = mailboxRowOf({
      tenant_id: "default",
      pause_id: "p",
      recipient: "listener:audit-listener",
      notices: [
        {
          seq: 1,
          kind: "timeout-changed",
          writtenAt: MID.toISOString(),
          expiresAt: LATER,
          actor: { id: "manager-17", orgId: "acme" },
          changeReason: "escalated",
        },
      ],
      delivered: 0,
      attempts: 0,
      next_attempt_at: MID,
      is_dead: false,
      problem: null,
      claim_token: null,
      claimed_until: null,
    });

    expect(stored.notices[0]).toMatchObject({
      actor: { id: "manager-17", orgId: "acme" },
      changeReason: "escalated",
    });
    expect(() =>
      mailboxRowOf({ ...stored, notices: [{ seq: 1, kind: "extended", writtenAt: "x" }] }),
    ).toThrow();
  });
});
