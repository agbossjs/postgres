import { describe, expect, it } from "vitest";
import {
  escapedJsonOf,
  escapedText,
  unescapedJson,
  unescapedText,
} from "../../src/stores/nul-escape.js";

/**
 * agbossjs/agboss#521 AC4: the escape every framework string bound for `jsonb` or free text goes
 * through — no U+0000 reaches PostgreSQL, and every string reads back as it was.
 */
const ESCAPE = "";
const HARD = [
  "",
  "plain",
  "\u0000",
  "a\u0000b\u0000",
  ESCAPE,
  `${ESCAPE}0`,
  `${ESCAPE}${ESCAPE}`,
  `\u0000${ESCAPE}0${ESCAPE}\u0000`,
  "\\u0000 spelled out",
  "before\u0000after \u0001\u001f \u{1F600}",
];

describe("AC4: the NUL escape (agbossjs/agboss#521)", () => {
  it.each(HARD)("AC4: %j round-trips, with no U+0000 kept", (text) => {
    const kept = escapedText(text);

    expect(kept).not.toContain("\u0000");
    expect(unescapedText(kept)).toBe(text);
  });

  it("AC4: U+0000 is U+E000 '0', U+E000 is doubled, nothing else changes", () => {
    expect(escapedText("a\u0000b")).toBe(`a${ESCAPE}0b`);
    expect(escapedText(`a${ESCAPE}b`)).toBe(`a${ESCAPE}${ESCAPE}b`);
    expect(escapedText("a0b \\u0000")).toBe("a0b \\u0000");
  });

  it("AC4: JSON for jsonb: every string and key escaped, no \\u0000 escape left; read back equal", () => {
    const value = {
      "key\u0000": ["a\u0000", { nested: `${ESCAPE}\u0000` }],
      count: 2,
      isSet: true,
      none: null,
    };

    const json = escapedJsonOf(value);

    expect(json).not.toContain("\\u0000");
    expect(unescapedJson(JSON.parse(json))).toEqual(value);
  });

  it("AC4: a value's own JSON is used — a Date becomes its ISO text, undefined fields go", () => {
    const json = escapedJsonOf({ at: new Date("2026-01-05T09:00:00Z"), gone: undefined });

    expect(JSON.parse(json)).toEqual({ at: "2026-01-05T09:00:00.000Z" });
  });
});
