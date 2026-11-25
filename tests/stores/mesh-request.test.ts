import { describe, expect, it } from "vitest";
import { PostgresMeshRequestRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";
import { keyOf, MESH_REQUEST_LEASE_MS, NINE, requestOf } from "./mesh-fixtures.js";

/**
 * The mesh requests' edges beyond the contract: a request without an answer has no `response`, an
 * answer of JSON `null` is still an answer, a retry against another instance finds the first one's
 * answer, only the attempt that holds a request answers, renews or forgets it (a stale one is
 * fenced), the sweep keeps what is not expired or still runs, and a lost connection rejects.
 */
const database = testDatabase();

const requestsOn = (url = database.url()) => new PostgresMeshRequestRepository(connectionTo(url));

const AFTER_LEASE = new Date(Date.parse(NINE) + MESH_REQUEST_LEASE_MS + 1).toISOString();

describe("PostgresMeshRequestRepository", () => {
  it("a request still running has no response field; an answer of null is kept as one", async () => {
    const requests = requestsOn();
    await requests.saveIfAbsent(requestOf("running"));
    await requests.saveIfAbsent(requestOf("null-answer"));

    expect(await requests.saveResponse(keyOf("null-answer"), "attempt-1", null)).toBe(true);

    expect(await requests.findByKey(keyOf("running"))).toEqual(requestOf("running"));
    expect(await requests.findByKey(keyOf("running"))).not.toHaveProperty("response");
    expect(await requests.findByKey(keyOf("null-answer"))).toEqual({
      ...requestOf("null-answer"),
      response: null,
    });
  });

  it("a retry against another instance is not saved again and finds the first one's answer", async () => {
    const [a, b] = [requestsOn(), requestsOn()];
    const answer = { status: "finished", output: { text: "paid", cents: 1250 } };
    expect(await a.saveIfAbsent(requestOf("retried"))).toBe(true);
    await a.saveResponse(keyOf("retried"), "attempt-1", answer);

    expect(
      await b.saveIfAbsent(requestOf("retried", "2026-01-05T09:00:01.000Z", "attempt-2")),
    ).toBe(false);
    expect(await b.findByKey(keyOf("retried"))).toEqual({
      ...requestOf("retried"),
      response: answer,
    });
  });

  it("an answer, a renewal and a forget for a key not kept change nothing and say so", async () => {
    const requests = requestsOn();

    expect(await requests.saveResponse(keyOf("never"), "attempt-1", { status: "finished" })).toBe(
      false,
    );
    expect(await requests.renewLease(keyOf("never"), "attempt-1", AFTER_LEASE)).toBe(false);
    expect(await requests.deleteByKey(keyOf("never"), "attempt-1")).toBe(false);

    expect(await requests.findByKey(keyOf("never"))).toBeUndefined();
  });

  it("only the attempt that holds a request answers it: a stale attempt's answer is fenced and writes nothing", async () => {
    const [a, b] = [requestsOn(), requestsOn()];
    await a.saveIfAbsent(requestOf("taken-over"));
    const later = requestOf("taken-over", AFTER_LEASE, "attempt-2");
    expect(await b.saveIfAbsent(later)).toBe(true);

    expect(await a.saveResponse(keyOf("taken-over"), "attempt-1", { who: "stale" })).toBe(false);
    expect(await a.renewLease(keyOf("taken-over"), "attempt-1", AFTER_LEASE)).toBe(false);
    expect(await a.deleteByKey(keyOf("taken-over"), "attempt-1")).toBe(false);
    expect(await b.saveResponse(keyOf("taken-over"), "attempt-2", { who: "owner" })).toBe(true);

    expect(await a.findByKey(keyOf("taken-over"))).toEqual({
      ...later,
      response: { who: "owner" },
    });
  });

  it("a request is answered once: a second answer of the same attempt is refused", async () => {
    const requests = requestsOn();
    await requests.saveIfAbsent(requestOf("once"));
    await requests.saveResponse(keyOf("once"), "attempt-1", { n: 1 });

    expect(await requests.saveResponse(keyOf("once"), "attempt-1", { n: 2 })).toBe(false);

    expect((await requests.findByKey(keyOf("once")))?.response).toEqual({ n: 1 });
  });

  it("a live lease is not taken over, nor one of another tool or arguments", async () => {
    const requests = requestsOn();
    await requests.saveIfAbsent(requestOf("held"));

    expect(await requests.saveIfAbsent(requestOf("held", NINE, "attempt-2"))).toBe(false);
    const other = { ...requestOf("held", AFTER_LEASE, "attempt-3"), requestHash: "sha256:bbbb" };
    expect(await requests.saveIfAbsent(other)).toBe(false);
    expect((await requests.findByKey(keyOf("held")))?.attemptId).toBe("attempt-1");
  });

  it("the sweep keeps a running request and one not yet expired, and removes an expired answered one", async () => {
    const requests = requestsOn();
    const expired = new Date(Date.parse(requestOf("answered").expiresAt));
    await requests.saveIfAbsent(requestOf("answered"));
    await requests.saveResponse(keyOf("answered"), "attempt-1", {});
    await requests.saveIfAbsent(requestOf("running"));

    expect(await requests.deleteExpired(new Date(expired.getTime() - 1))).toBe(0);
    await requests.deleteExpired(expired);

    expect(await requests.findByKey(keyOf("answered"))).toBeUndefined();
    expect(await requests.findByKey(keyOf("running"))).toBeDefined();
  });

  it("a lost connection rejects ping and every operation", async () => {
    const down = requestsOn("postgres://postgres:pw@127.0.0.1:1/postgres");

    await expect(down.ping()).rejects.toThrow();
    await expect(down.saveIfAbsent(requestOf("down"))).rejects.toThrow();
    await expect(down.findByKey(keyOf("down"))).rejects.toThrow();
    await expect(down.renewLease(keyOf("down"), "attempt-1", NINE)).rejects.toThrow();
    await expect(down.saveResponse(keyOf("down"), "attempt-1", {})).rejects.toThrow();
    await expect(down.deleteByKey(keyOf("down"), "attempt-1")).rejects.toThrow();
    await expect(down.deleteExpired(new Date(NINE))).rejects.toThrow();
  });
});
