import { StoredNamesUnreadableError } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { pauseAnswerOfJson, pausedRunOfJson } from "../../src/stores/framework-json.js";

/**
 * agbossjs/agboss#1121: a stored text that is not JSON is the coded `StoredNamesUnreadableError`
 * (`code: "stored.unreadable"`) with the ids of its row, as a record that fails its schema is, and
 * quotes no stored text anywhere (agbossjs/agboss#906 D4): the parse error is its `cause` without it.
 */
const SECRET = "ssn-078-05-1120";
const TEXTS = [
  `{"startInput":{"name":"${SECRET}"},"x":undefined}`,
  SECRET,
  `{"startInput":{"name":${SECRET}}}`,
];

const thrownBy = (read: () => unknown): unknown => {
  try {
    read();
  } catch (error) {
    return error;
  }
  return new Error("it was read");
};

function expectRefusal(error: unknown, record: string, ids: string): void {
  expect(error).toBeInstanceOf(StoredNamesUnreadableError);
  expect(error).toMatchObject({ code: "stored.unreadable", record, ids });
  if (!(error instanceof Error)) throw new TypeError("no error");
  expect(error.cause).toBeInstanceOf(SyntaxError);
  for (let link: unknown = error; link instanceof Error; link = link.cause) {
    expect(`${link.message}\n${link.stack ?? ""}`).not.toContain(SECRET);
    expect(`${link.message}\n${link.stack ?? ""}`).not.toMatch(/startInput|Unexpected|JSON\.parse/);
  }
}

describe.each(TEXTS)("a stored text that is not JSON: %#", (text) => {
  it("a paused run", () => {
    expectRefusal(
      thrownBy(() => pausedRunOfJson(text, { threadId: "t1", runId: "r1" })),
      "paused run",
      "threadId t1, runId r1",
    );
  });

  it("a pause answer", () => {
    expectRefusal(
      thrownBy(() => pauseAnswerOfJson(text)),
      "pause answer",
      "",
    );
  });
});
