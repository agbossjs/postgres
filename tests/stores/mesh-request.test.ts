import type { MeshRequestKey } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { PostgresMeshRequestRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * The mesh requests' edges beyond the contract: a request without an answer has no `response`, an
 * answer of JSON `null` is still an answer, a retry against another instance finds the first one's
 * answer, the sweep keeps a request admitted at its cutoff, and a lost connection rejects.
 */
const database = testDatabase();

const requestsOn = (url = database.url()) => new PostgresMeshRequestRepository(connectionTo(url));

const keyOf = (idempotencyKey: string): MeshRequestKey => ({
  tenantId: "acme",
  peer: "orders-application",
  idempotencyKey,
});

const NINE = "2026-01-05T09:00:00.000Z";

describe("PostgresMeshRequestRepository", () => {
  it("a request still running has no response field; an answer of null is kept as one", async () => {
    const requests = requestsOn();
    await requests.saveIfAbsent({ ...keyOf("running"), createdAt: NINE });
    await requests.saveIfAbsent({ ...keyOf("null-answer"), createdAt: NINE });

    await requests.saveResponse(keyOf("null-answer"), null);

    expect(await requests.findByKey(keyOf("running"))).toEqual({
      ...keyOf("running"),
      createdAt: NINE,
    });
    expect(await requests.findByKey(keyOf("running"))).not.toHaveProperty("response");
    expect(await requests.findByKey(keyOf("null-answer"))).toEqual({
      ...keyOf("null-answer"),
      createdAt: NINE,
      response: null,
    });
  });

  it("a retry against another instance is not saved again and finds the first one's answer", async () => {
    const [a, b] = [requestsOn(), requestsOn()];
    const answer = { status: "finished", output: { text: "paid", cents: 1250 } };
    expect(await a.saveIfAbsent({ ...keyOf("retried"), createdAt: NINE })).toBe(true);
    await a.saveResponse(keyOf("retried"), answer);

    expect(
      await b.saveIfAbsent({ ...keyOf("retried"), createdAt: "2026-01-05T09:00:01.000Z" }),
    ).toBe(false);
    expect(await b.findByKey(keyOf("retried"))).toEqual({
      ...keyOf("retried"),
      createdAt: NINE,
      response: answer,
    });
  });

  it("an answer for a key not kept changes nothing; a forget of it neither", async () => {
    const requests = requestsOn();

    await requests.saveResponse(keyOf("never"), { status: "finished" });
    await requests.deleteByKey(keyOf("never"));

    expect(await requests.findByKey(keyOf("never"))).toBeUndefined();
  });

  it("the sweep keeps a request admitted exactly at its cutoff", async () => {
    const requests = requestsOn();
    await requests.saveIfAbsent({ ...keyOf("at-cutoff"), createdAt: NINE });
    await requests.saveIfAbsent({
      ...keyOf("before-cutoff"),
      createdAt: "2026-01-05T08:59:59.999Z",
    });

    await requests.deleteCreatedBefore(new Date(NINE));

    expect(await requests.findByKey(keyOf("at-cutoff"))).toBeDefined();
    expect(await requests.findByKey(keyOf("before-cutoff"))).toBeUndefined();
  });

  it("a lost connection rejects ping and every operation", async () => {
    const down = requestsOn("postgres://postgres:pw@127.0.0.1:1/postgres");

    await expect(down.ping()).rejects.toThrow();
    await expect(down.saveIfAbsent({ ...keyOf("down"), createdAt: NINE })).rejects.toThrow();
    await expect(down.findByKey(keyOf("down"))).rejects.toThrow();
    await expect(down.saveResponse(keyOf("down"), {})).rejects.toThrow();
    await expect(down.deleteByKey(keyOf("down"))).rejects.toThrow();
    await expect(down.deleteCreatedBefore(new Date(NINE))).rejects.toThrow();
  });
});
