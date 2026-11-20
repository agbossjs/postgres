import { readdirSync } from "node:fs";
import { matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import { NON_SHARDED_SRC, SHARDS } from "../../scripts/mutation-shards.mjs";

/**
 * agbossjs/postgres#129 (the adapters' counterpart of the core's #1186): every module of `src/` is
 * mutated by some shard of `scripts/mutation-shards.mjs`, or is named in its reviewed
 * `NON_SHARDED_SRC` with the reason — a module that is neither (a helper extracted into `src/`, as
 * `listener.ts` and `drop-client.ts` were, #127) fails here and gets a conscious assignment.
 */
const repo = new URL("../../", import.meta.url).pathname;
const sources = (): readonly string[] =>
  readdirSync(`${repo}src`, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `src/${name}`)
    .sort();
const globs = Object.values(SHARDS).flatMap((shard) => shard.mutate);
const sharded = (file: string): boolean => globs.some((glob) => matchesGlob(file, glob));

describe("every module of src/ is in a mutation shard or named as not sharded", () => {
  it("has no module in neither", () => {
    expect(sources().filter((file) => !sharded(file) && !NON_SHARDED_SRC.has(file))).toEqual([]);
  });

  it("names no module that a shard mutates, or that is gone", () => {
    const all = new Set(sources());
    expect([...NON_SHARDED_SRC].filter((file) => sharded(file) || !all.has(file))).toEqual([]);
  });

  it("has every glob of a shard match some module", () => {
    const all = sources();
    expect(globs.filter((glob) => !all.some((file) => matchesGlob(file, glob)))).toEqual([]);
  });
});
