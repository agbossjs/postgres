import { StoredNamesUnreadableError } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { parsedOrUnreadable } from "../../src/stores/unreadable.js";

/** What `parsedOrUnreadable` refuses with: the record, the ids, the field, the cause's message. */
const messageOf = (error: StoredNamesUnreadableError): string =>
  error.cause instanceof Error ? error.cause.message : "no cause";

function refusalOf(
  text: string,
  ids: Readonly<Record<string, string | undefined>>,
  reviver?: (key: string, value: unknown) => unknown,
): StoredNamesUnreadableError {
  try {
    parsedOrUnreadable("a record", text, ids, reviver);
  } catch (error) {
    if (error instanceof StoredNamesUnreadableError) return error;
    throw error;
  }
  throw new Error("it was read");
}

describe("agbossjs/agboss#1213: parsedOrUnreadable names what it refuses", () => {
  it("reads a JSON text, through the reviver when there is one", () => {
    expect(parsedOrUnreadable("a record", '{"a":1}', {})).toEqual({ a: 1 });
    expect(parsedOrUnreadable("a record", "1", {}, (_key, value) => Number(value) + 1)).toBe(2);
  });

  it("names the record, the ids that are set (not those that are undefined) and the text as the field", () => {
    const refusal = refusalOf("{", { threadId: "t1", runId: undefined, step: "s2" });

    expect(refusal).toMatchObject({
      code: "stored.unreadable",
      record: "a record",
      ids: "threadId t1, step s2",
      fields: "(the text)",
    });
  });

  it("no ids at all is the empty ids text", () => {
    expect(refusalOf("{", { runId: undefined })).toMatchObject({ ids: "" });
  });

  it.each([
    ["{bad", "1"],
    ['{"a":1,"b":2 "c"}', "13"],
    ["[1,2,3,4,5,6,7,8,9 10]", "19"],
  ])("a parse error that names a position: the cause names it whole (%s)", (text, position) => {
    const refusal = refusalOf(text, {});

    expect(refusal.cause).toBeInstanceOf(SyntaxError);
    expect(messageOf(refusal)).toBe(`the text is not valid JSON (at position ${position})`);
  });

  it("a parse error that names no position: the cause does not either", () => {
    const refusal = refusalOf("", {});

    expect(refusal.cause).toBeInstanceOf(SyntaxError);
    expect(messageOf(refusal)).toBe("the text is not valid JSON");
  });

  it("a reviver that throws a value that is not an Error: refused the same, with no position", () => {
    const thrownValues: unknown[] = ["at position 5", null, undefined];
    for (const thrown of thrownValues) {
      const refusal = refusalOf("1", { runId: "r1" }, () => {
        throw thrown;
      });

      expect(refusal).toMatchObject({ ids: "runId r1" });
      expect(messageOf(refusal)).toBe("the text is not valid JSON");
    }
  });
});
