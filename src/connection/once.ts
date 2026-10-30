/**
 * `make` run on the first call, its promise shared by every later one; a rejection is not kept —
 * the next call runs `make` again (a database briefly unreachable is asked again).
 */
export function once<TValue>(make: () => Promise<TValue>): () => Promise<TValue> {
  let made: Promise<TValue> | undefined;
  return () => {
    made ??= make().catch((error: unknown) => {
      made = undefined;
      throw error;
    });
    return made;
  };
}
