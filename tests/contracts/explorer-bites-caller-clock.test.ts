import { beforeAll, describe, expect, it } from "vitest";
import { invariantsOf, literal, ranOf, runBites, type Found } from "./explorer-bites.js";
import { CALLER_CLOCK } from "./fixtures/explorer-bites.sets.js";

/**
 * agbossjs/agboss#590 on PostgreSQL: a lease store whose leases are decided by the caller's own
 * (skewed) clock — the explorer finds `one-live-holder`, and every failure prints its minimal
 * schedule. agbossjs/agboss#760: the lease world's exhaustive search and seeded walks, and the walks
 * of both outbound-call worlds — not their exhaustive searches, which take 6 of the set's 11
 * minutes and find nothing the walks do not.
 */
const SUITE = `interleavings (${CALLER_CLOCK})`;
const LEASE_WORLD = "every lease operation and leaseStateOf: ";
const CALL_WORLDS = [
  "an outbound call handed over on one tree: ",
  "an outbound call under one business key from two trees: ",
];
const WALKS = "\\d+ seeded walks";

let found: Found[] = [];

beforeAll(async () => {
  const worlds = [literal(LEASE_WORLD), ...CALL_WORLDS.map((world) => `${literal(world)}${WALKS}`)];
  found = ranOf(
    await runBites(
      "caller-clock.conformance-fixture.ts",
      new RegExp(`^${literal(SUITE)} (${worlds.join("|")})`, "u"),
    ),
  );
}, 900_000);

describe("agbossjs/agboss#590: the explorer bites on PostgreSQL — leases on the caller's clock", () => {
  it("the lease world's two searches and each outbound-call world's walks ran", () => {
    expect(found.every((one) => one.suite === SUITE)).toBe(true);
    expect(found.filter((one) => one.name.startsWith(LEASE_WORLD))).toHaveLength(2);
    for (const world of CALL_WORLDS)
      expect(found.filter((one) => one.name.startsWith(world))).toHaveLength(1);
  });

  it("one-live-holder in the lease world; every case fails with a printed minimal schedule", () => {
    const world = found.filter((one) => one.name.startsWith(LEASE_WORLD));

    expect(invariantsOf(world)).toContain("one-live-holder");
    expect(found.every((one) => one.state === "fail")).toBe(true);
    expect(found.every((one) => one.error.includes("minimal schedule ("))).toBe(true);
  });
});
