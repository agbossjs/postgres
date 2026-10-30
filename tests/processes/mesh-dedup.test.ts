/**
 * AC4 (agbossjs/agboss#483): a trusted mesh request is deduplicated across processes on
 * PostgreSQL. The test signs as the peer `orders-application` (the harness's key pair, which both
 * processes trust) and sends one A2A request — one idempotency key — to A, then the same request to
 * B, as a caller retrying against another pod would: it runs once, on A, and B answers with A's
 * answer. A request of another key runs again. The envelope is signed by the core's
 * `signedMeshEnvelope` (agbossjs/agboss#521), never built by hand.
 */
import { signedMeshEnvelope } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { eventsOf, launch, ORDERS_KEYS, type Instance } from "./instances.js";

const database = testDatabase();

/** The `agboss-mesh` header of `body`, signed as `orders-application` — the real client's format. */
const envelopeOf = (body: string, idempotencyKey: string): string =>
  signedMeshEnvelope({
    issuer: "orders-application",
    signingKey: ORDERS_KEYS.privateKey,
    body,
    // the envelope is the caller's: issued on its own clock, this test's
    issuedAt: new Date(),
    origin: {
      rootExecutionId: "orders-root-1",
      executionId: "orders-root-1",
      workflow: { name: "orders-workflow", version: "1.0.0" },
      step: { component: "orders-desk-agent", idempotencyKey, tool: "orders-call-peer-tool" },
    },
    callChain: [
      {
        application: "orders-application",
        start: "orders-workflow-start",
        executionId: "orders-root-1",
      },
    ],
  });

/** `POST <instance>/execute` of the limited workflow's start, signed with `idempotencyKey`. */
async function post(instance: Instance, idempotencyKey: string): Promise<unknown> {
  const body = JSON.stringify({ input: { name: "invoice-7" } });
  const response = await fetch(`${instance.a2aUrl}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "agboss-mesh": envelopeOf(body, idempotencyKey),
    },
    body,
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("AC4: mesh request deduplication across two processes", () => {
  it("AC4: a mesh request retried against another pod is deduplicated", async () => {
    const a = await launch(database.url());
    const b = await launch(database.url());

    const fromA = await post(a, "orders-root-1:orders-desk-agent:1:call_1");
    const fromB = await post(b, "orders-root-1:orders-desk-agent:1:call_1");

    expect(fromA).toMatchObject({
      status: "finished",
      output: { name: "invoice-7", by: a.instanceId },
    });
    expect(fromB).toEqual(fromA);
    expect(eventsOf(a, "limited-call")).toHaveLength(2); // one call: its start and its end
    expect(eventsOf(b, "limited-call")).toEqual([]);
    // another key is another request: it runs, here on B
    expect(await post(b, "orders-root-1:orders-desk-agent:1:call_2")).toMatchObject({
      status: "finished",
      output: { by: b.instanceId },
    });
  }, 120_000);
});
