import { beforeAll, describe, expect, it } from "vitest";
import { literal, runBites, type Found } from "./explorer-bites.js";
import { UNMARKED_CANCEL } from "./fixtures/explorer-bites.sets.js";

/**
 * agbossjs/agboss#909 on PostgreSQL, the fence reverted: a lease store whose cancel mark never
 * lands (`requestCancel` answers and writes nothing) fails the outbound-call contract's cancel cases
 * — a new intent and a new attempt of a cancelled tree are accepted — and the explorer finds
 * `no-effect-after-cancel`, each with its printed minimal schedule; the forced races of the cancel
 * with a send fail in the order that shows it. The real stores pass the same cases
 * (`store-conformance.test.ts`).
 */
const CONTRACT = `outbound call contract (${UNMARKED_CANCEL})`;
const EXPLORER = `interleavings (${UNMARKED_CANCEL})`;
const CALL_WORLD = "an outbound call handed over on one tree: ";

let found: Found[] = [];

beforeAll(async () => {
  found = await runBites(
    "unmarked-cancel.conformance-fixture.ts",
    new RegExp(
      `^(${literal(CONTRACT)} a tree's cancel is a fence|${literal(EXPLORER)} (${literal(CALL_WORLD)}|AC7: a new intent against its tree's cancel))`,
      "u",
    ),
  );
}, 900_000);

describe("agbossjs/agboss#909: the cancel's fence bites on PostgreSQL", () => {
  it("a new intent and a new attempt of a cancelled tree are accepted: the contract's cancel cases fail", () => {
    const contract = found.filter((one) => one.suite === CONTRACT);

    expect(contract.length).toBeGreaterThan(0);
    expect(contract.filter((one) => one.state === "fail").map((one) => one.name)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/saveIfAbsent after its tree's durable cancel is refused/u),
        expect.stringMatching(/markPending after the cancel is refused/u),
      ]),
    );
  });

  it("the explorer finds no-effect-after-cancel with a printed minimal schedule", () => {
    const explorer = found.filter((one) => one.suite === EXPLORER && one.state === "fail");

    expect(explorer.map((one) => one.error).join("\n")).toMatch(/\[no-effect-after-cancel\]/u);
    expect(explorer.some((one) => one.error.includes("minimal schedule ("))).toBe(true);
  });
});
