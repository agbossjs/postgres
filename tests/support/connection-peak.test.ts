import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { assertPeakUnder, PEAK_BOUND, sampleConnections } from "./connection-peak.js";
import { serverUrl } from "./database.js";

/**
 * agbossjs/agboss#978 AC1 — the suite's connection bound is enforced by the global setup, so the
 * sampler it uses is held to what it promises: it sees connections opened while it samples, it
 * reports the most at once (not the last count), and the bound refuses a peak over it by name.
 */
describe("agbossjs/agboss#978 AC1: the suite's peak of connections is counted and bounded", () => {
  const clients: pg.Client[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
  });

  const open = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      const client = new pg.Client({ connectionString: serverUrl() });
      clients.push(client);
      await client.connect();
    }
  };
  const closeAll = async (): Promise<void> => {
    await Promise.all(clients.splice(0).map((client) => client.end()));
  };

  it("AC1: reports the most connections held at once, after they closed again", async () => {
    const sampler = await sampleConnections(serverUrl());
    const baseline = sampler.peak();
    await open(7);
    // the sampler counts every 25 ms: hold them for several of its turns
    await new Promise((resolve) => setTimeout(resolve, 200));
    await closeAll();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const peak = await sampler.stop();

    expect(peak).toBeGreaterThanOrEqual(baseline + 7);
    expect(peak).toBe(sampler.peak());
  });

  it("AC1: a peak over the bound is refused naming both numbers; one at it is not", () => {
    expect(() => {
      assertPeakUnder(PEAK_BOUND, PEAK_BOUND);
    }).not.toThrow();
    expect(() => {
      assertPeakUnder(PEAK_BOUND + 1, PEAK_BOUND);
    }).toThrow(
      new RegExp(`${String(PEAK_BOUND + 1)} connections.*bound of ${String(PEAK_BOUND)}`, "u"),
    );
  });

  it("AC1: the bound leaves CI's max_connections (100) a margin", () => {
    expect(PEAK_BOUND).toBeLessThanOrEqual(64);
  });
});
