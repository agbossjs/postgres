import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DROP_BOUND_MS,
  DROP_CONCURRENCY,
  dropSchemas,
  leakLines,
  teardownTimeout,
} from "./drop-schemas.js";

/**
 * agbossjs/agboss#985 AC1, AC2 — the teardown of a test file's schemas on a slow server: every
 * drop bounded, in parallel, a leak named and counted, never a rejection.
 */
describe("agbossjs/agboss#985: dropSchemas", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops every schema, at most `concurrency` at once", async () => {
    let running = 0;
    let peak = 0;
    const names = Array.from({ length: 9 }, (_, i) => `t_${String(i)}`);
    const report = await dropSchemas(
      names,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await Promise.resolve();
        await Promise.resolve();
        running -= 1;
      },
      { concurrency: 3 },
    );
    expect(report).toEqual({ dropped: 9, leaked: [] });
    expect(peak).toBe(3);
  });

  it("a drop that never answers is a leak named by its schema: the others dropped, the teardown ends", async () => {
    vi.useFakeTimers();
    const pending = dropSchemas(
      ["t_slow", "t_a", "t_b"],
      (schema) => (schema === "t_slow" ? new Promise<void>(() => undefined) : Promise.resolve()),
      { boundMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(DROP_BOUND_MS);
    const report = await pending;
    expect(report.dropped).toBe(2);
    expect(report.leaked.map((leak) => leak.schema)).toEqual(["t_slow"]);
    expect(leakLines(report).join("\n")).toMatch(/1 of 3 test schemas leaked[\s\S]*t_slow/u);
  });

  it("14 schemas at 19 s a drop (76 s, past the default hook timeout) end inside the explicit one", async () => {
    vi.useFakeTimers();
    const slow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 19_000));
    const names = Array.from({ length: 14 }, (_, i) => `t_${String(i)}`);
    const pending = dropSchemas(names, slow);
    await vi.advanceTimersByTimeAsync(teardownTimeout(names.length));
    await expect(pending).resolves.toEqual({ dropped: 14, leaked: [] });
    expect(teardownTimeout(names.length)).toBeGreaterThan(60_000);
  });

  it("a hook's timeout is every wave of drops at its bound, and grows with the count", () => {
    expect(teardownTimeout(DROP_CONCURRENCY)).toBeGreaterThanOrEqual(DROP_BOUND_MS);
    expect(teardownTimeout(40)).toBeGreaterThan(teardownTimeout(8));
  });

  it("a drop that errors reports the schema's name and the reason", async () => {
    const report = await dropSchemas(["t_x", "t_y"], (schema) =>
      schema === "t_x" ? Promise.reject(new Error("not primary")) : Promise.resolve(),
    );
    expect(report.leaked).toEqual([{ schema: "t_x", reason: "not primary" }]);
    expect(leakLines(report)).toEqual([
      "1 of 2 test schemas leaked (not dropped):",
      "  t_x: not primary",
    ]);
  });

  it("nothing leaked: nothing to say", () => {
    expect(leakLines({ dropped: 3, leaked: [] })).toEqual([]);
  });

  it("no schemas: nothing to do", async () => {
    await expect(dropSchemas([], () => Promise.reject(new Error("never")))).resolves.toEqual({
      dropped: 0,
      leaked: [],
    });
  });
});
