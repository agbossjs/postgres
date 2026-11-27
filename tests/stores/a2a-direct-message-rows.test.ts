import { A2ADirectMessageState } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { directMessageOf } from "../../src/stores/a2a-direct-messages/a2a-direct-message-rows.js";

/**
 * The direct message a row reads as, with no database: the reply's token spend is kept when the row
 * has it and is no key when it has none (agbossjs/agboss#1321, mutation shard a2a-direct).
 */
const WHEN = new Date("2026-01-05T09:00:00.000Z");
const rowWith = (reply: object) => ({
  endpoint: "orders",
  tenant_id: "default",
  owner_id: "",
  message_id: "m-1",
  request_hash: "sha256:aaaa",
  skill: "refund",
  context_id: "c-1",
  state: A2ADirectMessageState.Completed,
  attempt_id: "attempt-1",
  calls_model: true,
  created_at: WHEN,
  started_at: WHEN,
  expires_at: WHEN,
  caller_peer: null,
  mesh_body_hash: null,
  reply,
  completed_at: WHEN,
});

describe("a completed direct message's reply as a row reads it", () => {
  it("keeps the token spend the reply has", () => {
    const read = directMessageOf(
      rowWith({ finish: "stop", output: { text: "paid" }, spentUsd: 0.25, spentTokens: 1200 }),
    );

    expect(read.reply).toEqual({
      finish: "stop",
      output: { text: "paid" },
      spentUsd: 0.25,
      spentTokens: 1200,
    });
    expect(read.completedAt).toEqual(WHEN);
  });

  it("has no spentTokens key at all when the reply has none", () => {
    const read = directMessageOf(rowWith({ finish: "stop", output: null, spentUsd: 0 }));

    expect(read.reply).toEqual({ finish: "stop", output: null, spentUsd: 0 });
    expect(read.reply).not.toHaveProperty("spentTokens");
  });
});
