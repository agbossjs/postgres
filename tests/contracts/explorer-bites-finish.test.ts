import { beforeAll, describe, expect, it } from "vitest";
import { invariantsOf, literal, ranOf, runBites, type Found } from "./explorer-bites.js";
import { FINISH_RELEASES } from "./fixtures/explorer-bites.sets.js";

/**
 * agbossjs/agboss#590 on PostgreSQL: a lease store whose `finish` only releases — the explorer's
 * lease world finds `no-takeover-of-finished-work`, and both forced #520 races of a finish fail.
 * agbossjs/agboss#760: only those cases run (the outbound-call worlds pass on this sabotage, 13 of
 * its 14 minutes).
 */
const SUITE = `interleavings (${FINISH_RELEASES})`;
const LEASE_WORLD = "every lease operation and leaseStateOf: ";
const FINISH_RACES = "AC7: finish ";

let found: Found[] = [];

beforeAll(async () => {
  found = ranOf(
    await runBites(
      "finish-releases.conformance-fixture.ts",
      new RegExp(`^${literal(SUITE)} (${literal(LEASE_WORLD)}|${literal(FINISH_RACES)})`, "u"),
    ),
  );
}, 900_000);

describe("agbossjs/agboss#590: the explorer bites on PostgreSQL — a finish that only releases", () => {
  it("only the lease world's two searches and the two races of a finish ran", () => {
    expect(found.every((one) => one.suite === SUITE)).toBe(true);
    expect(found.filter((one) => one.name.startsWith(LEASE_WORLD))).toHaveLength(2);
    expect(found.filter((one) => one.name.startsWith(FINISH_RACES))).toHaveLength(2);
  });

  it("no-takeover-of-finished-work in the lease world, with a printed minimal schedule", () => {
    const world = found.filter((one) => one.name.startsWith(LEASE_WORLD));

    expect(invariantsOf(world)).toContain("no-takeover-of-finished-work");
    expect(world.every((one) => one.state === "fail")).toBe(true);
    expect(world.every((one) => one.error.includes("minimal schedule ("))).toBe(true);
  });

  it("both #520 races of a finish fail, in both orders forced", () => {
    const races = found.filter((one) => one.name.startsWith(FINISH_RACES));

    expect(races.map((one) => one.state)).toEqual(["fail", "fail"]);
  });
});
