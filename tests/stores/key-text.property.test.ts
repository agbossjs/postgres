import {
  FencedEffectSettings,
  FencedEffectStatus,
  InvalidBusinessKeyError,
  KeyTextRule,
  keyTextRuleOf,
  type ExecutionLease,
  type FencedEffectKey,
  type OutboundCallIntent,
} from "@agboss/core";
import { VirtualClock, TestStoreClock } from "@agboss/core/testing";
import { hours } from "@agboss/core/units";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
} from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#538 AC2 on a real PostgreSQL (fast-check): every business key the core accepts —
 * any code points it lets through, graphemes of every script, look-alikes of one key — comes back byte for byte on
 * another connection, and two distinct accepted keys never meet in one row: an outbound call's
 * intent, a fenced effect's result. A key the core refuses is refused by every entry, naming the
 * rule, never the key — agbossjs/agboss#556's classes among them (a key with a variation selector,
 * a Hangul filler, a private-use or unassigned code point is no key: never a second row beside the
 * one without it).
 */
const database = testDatabase();

const RUNS = 40;

/** What the rules refuse, to be mixed in (agbossjs/agboss#556: what renders as nothing, private use, noncharacters, unassigned code points, the braille blank). */
const HAZARDS = [
  "\u0085",
  "­",
  "​",
  "‍",
  "‮",
  "﻿",
  "\ud800",
  "é",
  "\u034f",
  "\ufe0f",
  "\u3164",
  "\u115f",
  "\u{e0100}",
  "\ue000",
  "\u{f0000}",
  "\ufdd0",
  "\uffff",
  "\u{10ffff}",
  "\u0378",
  "\u2800",
];

const anyText = fc.oneof(
  fc
    .tuple(
      fc.string({ unit: "grapheme", maxLength: 20 }),
      fc.constantFrom(...HAZARDS),
      fc.string({ unit: "grapheme", maxLength: 20 }),
    )
    .map(([before, hazard, after]) => `${before}${hazard}${after}`),
  fc.string({ unit: "binary", minLength: 1, maxLength: 80 }),
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 }),
  fc.string({ unit: "binary-ascii", minLength: 1, maxLength: 200 }),
  fc.constantFrom("", "0", "a\u0000".slice(0, 2), "\u{F0000}"),
);

const acceptedKey = anyText.filter((text) => keyTextRuleOf(text) === undefined);

/** The texts a lenient store or collation would take for `key`: case, width, spaces. */
const lookalikesOf = (key: string): string[] => [
  ...new Set(
    [key, key.toUpperCase(), key.toLowerCase(), key.normalize("NFKC"), ` ${key}`, `${key} `].filter(
      (text) => keyTextRuleOf(text) === undefined,
    ),
  ),
];

const distinctKeys = fc.oneof(
  fc.uniqueArray(acceptedKey, { minLength: 1, maxLength: 6 }),
  acceptedKey.map(lookalikesOf),
);

const bytesOf = (text: string): number[] => [...new TextEncoder().encode(text)];

function instanceOn(clock: VirtualClock, index: number) {
  const connection = connectionTo(database.url(), 2);
  const application = new TestApplicationContext({}, `instance-${String(index)}`);
  return {
    calls: new PostgresOutboundCallRepository(connection, new TestStoreClock(clock)),
    effects: new PostgresFencedEffectRepository(
      connection,
      new TestStoreClock(clock),
      new FencedEffectSettings(),
    ),
    leases: new PostgresExecutionLeaseRepository(
      connection,
      new TestStoreClock(clock),
      application,
    ),
  };
}

const keyOf = (lease: ExecutionLease, name: string, businessKey: string): FencedEffectKey => ({
  scopeKey: `${lease.tenantId}:${lease.rootExecutionId}`,
  tenantId: lease.tenantId,
  leaseExecutionId: lease.rootExecutionId,
  token: lease.leaseEpoch,
  idempotencyKey: `${lease.rootExecutionId}:charge-action:1`,
  name,
  businessKey,
});

const intentOf = (key: FencedEffectKey, index: number): OutboundCallIntent => ({
  rootExecutionId: key.leaseExecutionId,
  executionId: key.leaseExecutionId,
  workflow: "charge-workflow",
  target: "payments",
  operation: "charge",
  idempotencyKey: `${key.idempotencyKey}:${key.name}`,
  request: JSON.stringify({ index }),
  attempt: 1,
  attemptOwner: "owner-1",
  step: { nodeId: "charge-action", visitNumber: 1 },
});

/** The round's own lease and effect name: every run writes rows of its own. */
async function roundOf(stores: ReturnType<typeof instanceOn>, test: string, round: number) {
  const lease = await stores.leases.acquire("default", `${test}-${String(round)}`, hours(1));
  if (lease === undefined) throw new Error("the round's lease is held");
  // the effect's name is the test's and the round's own: a business key is one row per tenant, name
  // and key whatever the step (agbossjs/agboss#508), so a short key two tests both draw ("__")
  // under one name would be the earlier test's row
  return (businessKey: string) => keyOf(lease, `charge-${test}-${String(round)}`, businessKey);
}

describe("agbossjs/agboss#538 AC2: business keys on PostgreSQL", () => {
  it("an outbound call's intent: every accepted key comes back byte for byte on another connection, distinct keys distinct intents", async () => {
    const clock = new VirtualClock();
    const [first, second] = [instanceOn(clock, 1), instanceOn(clock, 2)];
    let round = 0;

    await fc.assert(
      fc.asyncProperty(distinctKeys, async (keys) => {
        round += 1;
        const keyed = await roundOf(first, "calls", round);
        for (const [index, businessKey] of keys.entries())
          expect(
            await first.calls.saveIfAbsent(keyed(businessKey), intentOf(keyed(businessKey), index)),
          ).toBe(true);
        for (const [index, businessKey] of keys.entries()) {
          const found = await second.calls.findByKey(keyed(businessKey));
          expect(bytesOf(found?.businessKey ?? "")).toEqual(bytesOf(businessKey));
          expect(found?.request).toBe(JSON.stringify({ index }));
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("a fenced effect: distinct accepted keys each run once and replay their own result on another connection", async () => {
    const clock = new VirtualClock();
    const [first, second] = [instanceOn(clock, 1), instanceOn(clock, 2)];
    let round = 0;

    await fc.assert(
      fc.asyncProperty(distinctKeys, async (keys) => {
        round += 1;
        const keyed = await roundOf(first, "effects", round);
        for (const [index, businessKey] of keys.entries()) {
          const ran = await first.effects.saveResultIfAbsent(keyed(businessKey), () => ({
            receipt: `r${String(index)}`,
          }));
          expect(ran.status).toBe(FencedEffectStatus.Ran);
        }
        for (const [index, businessKey] of keys.entries()) {
          const replayed = await second.effects.saveResultIfAbsent(keyed(businessKey), () => ({
            receipt: "never",
          }));
          expect(replayed).toMatchObject({
            status: FencedEffectStatus.Replayed,
            result: { receipt: `r${String(index)}` },
          });
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("any text the core refuses is refused at every entry, naming its rule, never the text; nothing stored", async () => {
    const clock = new VirtualClock();
    const stores = instanceOn(clock, 1);
    let round = 0;
    const refused = anyText.filter((text) => keyTextRuleOf(text) !== undefined);
    // the message of each entry and rule, first seen: it names no text, so it is every text's
    const messages = new Map<string, string>();

    await fc.assert(
      fc.asyncProperty(refused, async (text) => {
        round += 1;
        const rule = keyTextRuleOf(text);
        const key = (await roundOf(stores, "refused", round))(text);
        const calls = [
          stores.calls.findByKey(key),
          stores.calls.saveIfAbsent(key, intentOf(key, 0)),
          stores.calls.markCompleted(key, "owner-1", '"done"'),
          stores.effects.saveResultIfAbsent(key, () => ({ receipt: "r" })),
        ];
        for (const [entry, call] of calls.entries()) {
          const error = await call.then(
            () => undefined,
            (thrown: unknown) => thrown,
          );
          expect(error).toBeInstanceOf(InvalidBusinessKeyError);
          expect(error).toMatchObject({ rule });
          const { message } = error as Error;
          // the effect's name is the round's own; everything else is the same for every text
          const shown = message.replaceAll(key.name, "<name>");
          const seen = `${String(entry)}:${String(rule)}`;
          expect(shown).toBe(messages.get(seen) ?? shown);
          messages.set(seen, shown);
          // a spacing text is plain ASCII spaces and letters (" ", " is"), in any English message
          if (rule !== KeyTextRule.Spacing) expect(message).not.toContain(text);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("agbossjs/agboss#556: an accepted key with one invisible, private or unassigned character put in is refused at every entry; the key itself keeps its one row", async () => {
    const clock = new VirtualClock();
    const [first, second] = [instanceOn(clock, 1), instanceOn(clock, 2)];
    const invisible = fc.constantFrom(...HAZARDS.slice(8));
    let round = 0;

    await fc.assert(
      fc.asyncProperty(acceptedKey, invisible, fc.nat(), async (key, char, at) => {
        round += 1;
        const keyed = await roundOf(first, "invisible", round);
        const cut = Array.from(key);
        const index = at % (cut.length + 1);
        const variant = [...cut.slice(0, index), char, ...cut.slice(index)].join("");
        expect(keyTextRuleOf(variant)).not.toBeUndefined();
        expect(await first.calls.saveIfAbsent(keyed(key), intentOf(keyed(key), 0))).toBe(true);
        for (const call of [
          second.calls.findByKey(keyed(variant)),
          second.calls.saveIfAbsent(keyed(variant), intentOf(keyed(variant), 1)),
          second.effects.saveResultIfAbsent(keyed(variant), () => ({ receipt: "r" })),
        ]) {
          const error = await call.then(
            () => undefined,
            (thrown: unknown) => thrown,
          );
          expect(error).toBeInstanceOf(InvalidBusinessKeyError);
          expect(error).toMatchObject({ rule: keyTextRuleOf(variant) });
        }
        expect(bytesOf((await second.calls.findByKey(keyed(key)))?.businessKey ?? "")).toEqual(
          bytesOf(key),
        );
      }),
      { numRuns: RUNS },
    );
  });
});
