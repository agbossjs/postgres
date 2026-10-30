/**
 * PostgreSQL keeps no NUL character (U+0000): `text` refuses it and `jsonb` refuses the escape
 * `\u0000` (agbossjs/agboss#521). A model's or a tool's answer may hold one, and a store gives back
 * what the framework hands it. So every string a store keeps in `jsonb` or as free text is escaped
 * on the way in and unescaped on the way out, reversibly, with U+E000 (a private-use character) as
 * the escape: U+0000 → U+E000 `0`, U+E000 → U+E000 U+E000. Nothing else changes, so `jsonb`'s
 * operators and the columns read by SQL keep working; migration 0013 escapes the U+E000 an older
 * row already held.
 */

const ESCAPE = "";
const NUL = "\u0000";
const ESCAPED = /([0])/g;

/** A string as a column keeps it: no U+0000. */
export const escapedText = (text: string): string =>
  text.replaceAll(ESCAPE, ESCAPE + ESCAPE).replaceAll(NUL, `${ESCAPE}0`);

/** The string `escapedText` kept. */
export const unescapedText = (text: string): string =>
  text.replace(ESCAPED, (_escape, next: string) => (next === ESCAPE ? ESCAPE : NUL));

/** A JSON value with every string — object keys too — mapped by `map`. */
function mappedStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item: unknown) => mappedStrings(item, map));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [map(key), mappedStrings(item, map)]),
  );
}

/** A value as the JSON text of a `jsonb` parameter, its strings escaped (`JSON.stringify` first). */
export const escapedJsonOf = (value: unknown): string =>
  JSON.stringify(mappedStrings(JSON.parse(JSON.stringify(value)), escapedText));

/** A `jsonb` column's value as the driver parsed it, its strings unescaped. */
export const unescapedJson = (value: unknown): unknown => mappedStrings(value, unescapedText);
