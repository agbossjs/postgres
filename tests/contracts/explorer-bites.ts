import { fileURLToPath } from "node:url";
import { startVitest } from "vitest/node";
import type { RunnerTask } from "vitest";

/**
 * agbossjs/agboss#590 (and #533 AC1 on PostgreSQL): the interleaving explorer, run by
 * `storeConformance` on PostgreSQL, catches broken lease stores with the invariant each breaks. A
 * broken set's fixture runs in a vitest of its own, so its failures are read, not this run's.
 * agbossjs/agboss#760: one sabotage per test file, each running only the cases its assertions read
 * (`pattern`, matched against `<suite> <case>`) — the contract suites and the worlds a sabotage
 * passes cost 25 of the 29 minutes the single file took on a loaded machine, and proved nothing.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** One case of the fixture's run. */
export interface Found {
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

/** Runs `fixture` (under `tests/contracts/fixtures/`) with only the cases `pattern` names. */
export async function runBites(fixture: string, pattern: RegExp): Promise<Found[]> {
  const exitCode = process.exitCode;
  const vitest = await startVitest("test", [], {
    root: ROOT,
    config: false,
    watch: false,
    include: [`tests/contracts/fixtures/${fixture}`],
    testNamePattern: pattern,
    globalSetup: [],
    reporters: [{}],
    coverage: { enabled: false },
    testTimeout: 120_000,
  });
  try {
    return vitest.state
      .getFiles()
      .flatMap((file) => file.tasks.flatMap((task) => casesOf(task, [])));
  } finally {
    await vitest.close();
    process.exitCode = exitCode;
  }
}

/** The cases that ran (filtered ones are skipped). */
export const ranOf = (found: readonly Found[]): Found[] =>
  found.filter((one) => one.state === "pass" || one.state === "fail");

/** The invariants named by the failing explorer cases of `found`. */
export const invariantsOf = (found: readonly Found[]): ReadonlySet<string> =>
  new Set(
    found
      .filter((one) => one.state === "fail")
      .flatMap((one) => /\): \[([a-z-]+)\]/u.exec(one.error)?.[1] ?? []),
  );

/** A RegExp source matching `text` literally. */
export const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
