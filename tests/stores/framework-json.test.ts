import { describe, expect, it } from "vitest";
import {
  pauseRecordOf,
  pausedRunJsonOf,
  pausedRunOfJson,
} from "../../src/stores/framework-json.js";
import { oldPause, oldPausedRun } from "./pause-names-0.1.0.fixtures.js";

/**
 * agbossjs/agboss#1213: the paused run's text keeps what JSON cannot (`Infinity`, `-Infinity`,
 * `NaN`) as a `{ "$number": … }` tag and reads it back; nothing else is tagged or untagged.
 */
const IDS = { threadId: "thread-1", runId: "run-1" };

const base = pausedRunOfJson(
  JSON.stringify({ ...oldPausedRun, threadId: "thread-1", runId: "run-1", tenantId: "acme" }),
  IDS,
);

const textOf = (startInput: unknown, budgetUsd = 5): string =>
  pausedRunJsonOf({ ...base, budgetUsd, startInput });

describe("agbossjs/agboss#1213: paused run text and non-finite numbers", () => {
  it("writes each non-finite number as its tag and every other value as JSON does", () => {
    const written: unknown = JSON.parse(
      textOf(
        { up: Infinity, down: -Infinity, nan: NaN, one: 1, zero: 0, word: "Infinity" },
        Infinity,
      ),
    );

    expect(written).toMatchObject({
      budgetUsd: { $number: "Infinity" },
      startInput: {
        up: { $number: "Infinity" },
        down: { $number: "-Infinity" },
        nan: { $number: "NaN" },
        one: 1,
        zero: 0,
        word: "Infinity",
      },
    });
  });

  it("a finite budget stays a plain number", () => {
    expect(JSON.parse(textOf({}, 5))).toMatchObject({ budgetUsd: 5 });
  });

  it("reads the tags back as the numbers they stand for", () => {
    const run = pausedRunOfJson(
      textOf({ up: Infinity, down: -Infinity, nan: NaN, one: 1 }, Infinity),
      IDS,
    );

    expect(run.budgetUsd).toBe(Infinity);
    expect(run.startInput).toEqual({ up: Infinity, down: -Infinity, nan: NaN, one: 1 });
  });

  it("an object that only looks like a tag stays an object", () => {
    const lookalikes = {
      unknown: { $number: "1" },
      empty: { $number: "" },
      wrongCase: { $number: "infinity" },
      none: {},
      other: { number: "Infinity" },
    };

    const run = pausedRunOfJson(textOf(lookalikes), IDS);

    expect(run.startInput).toEqual(lookalikes);
  });
});

describe("agbossjs/agboss#1213: pauseRecordOf", () => {
  it("reads a pause the core's way, 0.1.0 names included", () => {
    expect(pauseRecordOf(oldPause)).toMatchObject({
      pauseId: "p1",
      tenantId: "default",
      status: "resolved",
      kind: "approval",
    });
  });
});
