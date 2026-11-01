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

/**
 * `FC_SEED=-1186302779` (or a list, `FC_SEED=-1186302779,1,2`) runs every property at each seed
 * (agbossjs/agboss#624); unset, once, at a seed fast-check draws and prints on a failure.
 */
const SEEDS: readonly (number | undefined)[] = seedsOf(process.env.FC_SEED);

function seedsOf(text: string | undefined): readonly (number | undefined)[] {
  const listed = (text ?? "").split(",").filter((part) => part.trim() !== "");
  if (listed.length === 0) return [undefined];
  return listed.map((part) => {
    const seed = Number(part);
    if (!Number.isSafeInteger(seed)) throw new Error(`FC_SEED: "${part}" is not an integer seed`);
    return seed;
  });
}

/** fast-check's parameters of one property at `seed`. */
const runsAt = (seed: number | undefined) =>
  seed === undefined ? { numRuns: RUNS } : { numRuns: RUNS, seed };

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

/**
 * The rounds of the whole file, whatever their test, seed or shrink (agbossjs/agboss#624): each
 * the next number of one sequence, so no two rounds ever share a lease or an effect name.
 */
let rounds = 0;

/**
 * The next round's own lease and effect name. A business key is one row per tenant, name and key
 * whatever the execution (agbossjs/agboss#508): two rounds under one name are one row for a key
 * both draw — the `false` of agbossjs/agboss#624, a short key ("key") two tests drew in their round
 * 5 under the name `charge-5`.
 */
async function nextRound(stores: Stores, test: string) {
  rounds += 1;
  const round = `${test}-${String(rounds)}`;
  const lease = await stores.leases.acquire("default", round, hours(1));
  if (lease === undefined) throw new Error(`the lease of round ${round} is held`);
  return (businessKey: string) => keyOf(lease, `charge-${round}`, businessKey);
}

type Stores = ReturnType<typeof instanceOn>;
type Keyed = (businessKey: string) => FencedEffectKey;

/**
 * A key the round is about to save has no row yet, on the other connection: a row here is another
 * round's (the test's isolation broken), told apart from a store that refuses a fresh key.
 */
async function expectFresh(stores: Stores, keyed: Keyed, keys: readonly string[]): Promise<void> {
  for (const key of keys)
    expect(await stores.calls.findByKey(keyed(key)), "a row of another round").toBeUndefined();
}

/** Distinct accepted keys are distinct intents, each read back byte for byte on `second`. */
const callsProperty = (first: Stores, second: Stores) =>
  fc.asyncProperty(distinctKeys, async (keys) => {
    const keyed = await nextRound(first, "calls");
    await expectFresh(second, keyed, keys);
    for (const [index, businessKey] of keys.entries())
      expect(
        await first.calls.saveIfAbsent(keyed(businessKey), intentOf(keyed(businessKey), index)),
      ).toBe(true);
    for (const [index, businessKey] of keys.entries()) {
      const found = await second.calls.findByKey(keyed(businessKey));
      expect(bytesOf(found?.businessKey ?? "")).toEqual(bytesOf(businessKey));
      expect(found?.request).toBe(JSON.stringify({ index }));
    }
  });

/** An accepted key with one refused character put in is refused; the key keeps its one row. */
const invisibleProperty = (first: Stores, second: Stores) =>
  fc.asyncProperty(
    acceptedKey,
    fc.constantFrom(...HAZARDS.slice(8)),
    fc.nat(),
    async (key, char, at) => {
      const keyed = await nextRound(first, "invisible");
      const cut = Array.from(key);
      const index = at % (cut.length + 1);
      const variant = [...cut.slice(0, index), char, ...cut.slice(index)].join("");
      expect(keyTextRuleOf(variant)).not.toBeUndefined();
      await expectFresh(second, keyed, [key]);
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
    },
  );

/** Two instances on one clock. */
const twoInstances = (): [Stores, Stores] => {
  const clock = new VirtualClock();
  return [instanceOn(clock, 1), instanceOn(clock, 2)];
};

describe("agbossjs/agboss#624: the property runs of the file never share a row", () => {
  it("main's counterexample: the intents' property at seed 23 draws \"key\" in its round 5, then the #556 property at seed -1186302779 draws it in its round 5 — each saves it first", async () => {
    const [first, second] = twoInstances();

    await fc.assert(callsProperty(first, second), { numRuns: RUNS, seed: 23 });
    await fc.assert(invisibleProperty(first, second), { numRuns: RUNS, seed: -1186302779 });
  });

  it('the CI counterexample\'s draws: seed 23\'s round 5 holds "key" and seed -1186302779\'s round 5 is ["key", U+FE0F, …] — the regression above still meets its collision', () => {
    const calls = fc.sample(distinctKeys, { numRuns: 5, seed: 23 });
    const [invisible] = fc
      .sample(fc.tuple(acceptedKey, fc.constantFrom(...HAZARDS.slice(8)), fc.nat()), {
        numRuns: 5,
        seed: -1186302779,
      })
      .slice(4);

    expect(calls[4]).toContain("key");
    expect(invisible?.slice(0, 2)).toEqual(["key", "\ufe0f"]);
  });
});

for (const seed of SEEDS)
  describe(`agbossjs/agboss#538 AC2: business keys on PostgreSQL (seed ${String(seed ?? "drawn")})`, () => {
    it("an outbound call's intent: every accepted key comes back byte for byte on another connection, distinct keys distinct intents", async () => {
      const [first, second] = twoInstances();

      await fc.assert(callsProperty(first, second), runsAt(seed));
    });

    it("a fenced effect: distinct accepted keys each run once and replay their own result on another connection", async () => {
      const [first, second] = twoInstances();

      await fc.assert(
        fc.asyncProperty(distinctKeys, async (keys) => {
          const keyed = await nextRound(first, "effects");
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
        runsAt(seed),
      );
    });

    it("any text the core refuses is refused at every entry, naming its rule, never the text; nothing stored", async () => {
      const stores = instanceOn(new VirtualClock(), 1);
      const refused = anyText.filter((text) => keyTextRuleOf(text) !== undefined);
      // the message of each entry and rule, first seen: it names no text, so it is every text's
      const messages = new Map<string, string>();

      await fc.assert(
        fc.asyncProperty(refused, async (text) => {
          const rule = keyTextRuleOf(text);
          const key = (await nextRound(stores, "refused"))(text);
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
        runsAt(seed),
      );
    });

    it("agbossjs/agboss#556: an accepted key with one invisible, private or unassigned character put in is refused at every entry; the key itself keeps its one row", async () => {
      const [first, second] = twoInstances();

      await fc.assert(invisibleProperty(first, second), runsAt(seed));
    });
  });
