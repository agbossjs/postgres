import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { startVitest } from "vitest/node";
import type { RunnerTask } from "vitest";

/**
 * agbossjs/agboss#590 (and #533 AC1 on PostgreSQL): the interleaving explorer, run by
 * `storeConformance` on PostgreSQL, catches broken lease stores with the invariant each breaks — a
 * `finish` that only releases (`no-takeover-of-finished-work`), leases decided by the caller's own
 * skewed clock (`one-live-holder`) — and its forced races catch the first. The fixture runs in a
 * vitest of its own, so its failures are read, not this run's.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface Found {
  readonly suite: string;
  readonly name: string;
  readonly state: string | undefined;
  readonly error: string;
}

const casesOf = (task: RunnerTask, suites: readonly string[]): Found[] =>
  task.type === "suite"
    ? task.tasks.flatMap((child) => casesOf(child, [...suites, task.name]))
    : [
        {
          suite: suites[0] ?? "",
          name: task.name,
          state: task.result?.state,
          error: task.result?.errors?.[0]?.message ?? "",
        },
      ];

let found: Found[] = [];

beforeAll(async () => {
  const exitCode = process.exitCode;
  const vitest = await startVitest("test", [], {
    root: ROOT,
    config: false,
    watch: false,
    include: ["tests/contracts/fixtures/explorer-bites.conformance-fixture.ts"],
    globalSetup: [],
    reporters: [{}],
    coverage: { enabled: false },
    testTimeout: 120_000,
  });
  try {
    found = vitest.state
      .getFiles()
      .flatMap((file) => file.tasks.flatMap((task) => casesOf(task, [])));
  } finally {
    await vitest.close();
    process.exitCode = exitCode;
  }
}, 900_000);

/** The invariants named by the failing explorer cases of `name`'s set. */
const invariantsOf = (name: string): ReadonlySet<string> =>
  new Set(
    found
      .filter((one) => one.suite === `interleavings (${name})` && one.state === "fail")
      .flatMap((one) => /\): \[([a-z-]+)\]/u.exec(one.error)?.[1] ?? []),
  );

describe("agbossjs/agboss#590: the explorer bites on PostgreSQL", () => {
  it("a finish that only releases: no-takeover-of-finished-work, and both #520 races", () => {
    expect(invariantsOf("a finish that only releases")).toContain("no-takeover-of-finished-work");
    const races = found.filter(
      (one) =>
        one.suite === "interleavings (a finish that only releases)" &&
        one.name.startsWith("AC7: finish") &&
        one.state === "fail",
    );
    expect(races).toHaveLength(2);
  });

  it("leases on the caller's clock: one-live-holder, with a printed minimal schedule", () => {
    expect(invariantsOf("leases on the caller's clock")).toContain("one-live-holder");
    const failed = found.filter(
      (one) =>
        one.suite === "interleavings (leases on the caller's clock)" &&
        one.state === "fail" &&
        !one.name.startsWith("AC7"),
    );
    expect(failed.every((one) => one.error.includes("minimal schedule ("))).toBe(true);
  });
});
