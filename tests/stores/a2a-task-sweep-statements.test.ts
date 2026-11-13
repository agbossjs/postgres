import { describe, expect, it } from "vitest";
import { sweptOrphanMessagesBefore } from "../../src/stores/a2a-tasks/a2a-task-statements.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#960: the orphan sweep is safe against a resend only because it is ONE statement
 * (a per-statement snapshot). A read of the messages and a delete after it would bring back the
 * MongoDB double charge, which the race test cannot see in every shape: this pins the shape — the
 * sweep sends exactly one statement, a DELETE of the messages table, and no SELECT of it.
 */
const database = testDatabase();

describe("agbossjs/agboss#960: the orphan sweep is one statement", () => {
  it("sends exactly one DELETE of the messages and no SELECT of them", async () => {
    const client = await connectionTo(database.url()).pool.connect();
    const sent: string[] = [];
    const query = client.query.bind(client);
    const recording = (...args: unknown[]): unknown => {
      const [text] = args;
      if (typeof text === "string") sent.push(text);
      const result: unknown = Reflect.apply(query, client, args);
      return result;
    };
    const counting = new Proxy(client, {
      get: (target, property, receiver): unknown => {
        if (property === "query") return recording;
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    });
    try {
      await sweptOrphanMessagesBefore(counting, new Date());
    } finally {
      client.release();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\s*DELETE FROM agboss_a2a_messages\b/u);
    expect(sent.filter((sql) => /\bSELECT\b[^)]*\bFROM agboss_a2a_messages\b/iu.test(sql))).toEqual(
      [],
    );
  });
});
