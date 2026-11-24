import { describe, expect, it } from "vitest";
import { listingWindowOf, pageOfWindow } from "../../src/stores/listing-window.js";

/** A listing's window (agbossjs/agboss#1321b): the cursor is a position a page gave, never a guess. */
describe("listingWindowOf", () => {
  it("no cursor is the first page, of the default size", () => {
    expect(listingWindowOf({})).toEqual({ offset: 0, limit: 100 });
  });

  it("a cursor is the position the page before ended at", () => {
    expect(listingWindowOf({ cursor: "20", limit: 5 })).toEqual({ offset: 20, limit: 5 });
  });

  it.each(["", "-1", "1.5", "abc", "1 ", "1234567890123456"])(
    "%j is no cursor a page gave",
    (cursor) => {
      expect(() => listingWindowOf({ cursor })).toThrow(RangeError);
    },
  );

  it.each([0, 1.5, -1, Number.NaN])("a limit of %j is refused", (limit) => {
    expect(() => listingWindowOf({ limit })).toThrow(RangeError);
  });
});

describe("pageOfWindow", () => {
  const window = { offset: 10, limit: 2 };

  it("a row past the limit makes a next cursor at the position after the page", () => {
    expect(pageOfWindow(["a", "b", "c"], window)).toEqual({
      items: ["a", "b"],
      nextCursor: "12",
    });
  });

  it("a last page has no cursor", () => {
    expect(pageOfWindow(["a", "b"], window)).toEqual({ items: ["a", "b"] });
    expect(pageOfWindow([], window)).toEqual({ items: [] });
  });
});
