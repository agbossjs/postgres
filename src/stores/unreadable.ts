/** ` (threadId t, runId r)`, or nothing when no id is known. */
const named = (ids: string): string => (ids === "" ? "" : ` (${ids})`);

/**
 * The text as JSON. A parser's message quotes the text it failed on (`startInput`, PII, #906 D4):
 * a failure is refused by name, `ids` the store's own keys of the row, with neither the text nor
 * the parser's message, and no cause.
 */
export function parsedOrUnreadable(
  what: string,
  text: string,
  ids: Readonly<Record<string, string | undefined>>,
  reviver?: (key: string, value: unknown) => unknown,
): unknown {
  try {
    return JSON.parse(text, reviver);
  } catch {
    const parts = Object.entries(ids).flatMap(([key, id]) =>
      id === undefined ? [] : [`${key} ${id}`],
    );
    throw new Error(
      `a stored ${what} is not readable${named(parts.join(", "))}: the text is not valid JSON`,
    );
  }
}
