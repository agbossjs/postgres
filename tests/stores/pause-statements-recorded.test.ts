import { PauseStatus } from "@agboss/core";
import pg from "pg";
import { ZodError } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { claimDue, UNREADABLE_MAILBOX } from "../../src/stores/paused/pause-delivery-rows.js";
import { PauseScans } from "../../src/stores/paused/pause-scans.js";

/**
 * The statements the pause listing and the mailbox claim send (agbossjs/agboss#1307e, #1419 L8),
 * recorded on a pool that answers nothing: which conditions a filter puts in, with which values, and
 * what the claim does with a row that does not read. What the database answers is the contract
 * suite's.
 */
interface Sent {
  readonly sql: string;
  readonly values: readonly unknown[];
}

const pools: pg.Pool[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.end();
});

/** A pool that records every statement and answers `answers` in turn (empty rows after). */
function poolAnswering(answers: readonly (readonly object[])[] = []): {
  readonly pool: pg.Pool;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  const queue = [...answers];
  // a real pool that never connects: its `query` is the recording one
  const pool = new pg.Pool();
  Reflect.set(pool, "query", (sql: string, values: readonly unknown[]) => {
    sent.push({ sql, values });
    const rows = queue.shift() ?? [];
    return Promise.resolve({ rows, rowCount: rows.length });
  });
  pools.push(pool);
  return { pool, sent };
}

const squeezed = (sql: string): string => sql.replace(/\s+/gu, " ");
const PENDING = { statuses: [PauseStatus.Pending] };

describe("the pause listing's statement", () => {
  it("a tenant's page names the tenant; the cross-tenant page names none", async () => {
    const tenant = poolAnswering();
    const every = poolAnswering();

    await new PauseScans(tenant.pool).ofTenant("acme", PENDING, "0", 10);
    await new PauseScans(every.pool).ofAllTenants(PENDING, "0", 10);

    expect(squeezed(tenant.sent[0]?.sql ?? "")).toContain(
      "WHERE seq > $1::bigint AND tenant_id = $2 AND status = ANY($3::text[])",
    );
    expect(tenant.sent[0]?.values).toEqual(["0", "acme", ["pending"], 11]);
    expect(every.sent[0]?.sql).not.toContain("tenant_id");
    expect(every.sent[0]?.values).toEqual(["0", ["pending"], 11]);
    expect(squeezed(every.sent[0]?.sql ?? "")).toContain("ORDER BY seq LIMIT $3");
  });

  it("each filter is one condition on the record's own JSON, with its value as a parameter", async () => {
    const { pool, sent } = poolAnswering();

    await new PauseScans(pool).ofAllTenants(
      {
        ...PENDING,
        target: "refund",
        channel: "slack",
        assignee: "ann",
        externalRef: "JIRA-1",
        expiresBefore: new Date("2026-01-05T10:00:00.000Z"),
      },
      "7",
      2,
    );

    const sql = squeezed(sent[0]?.sql ?? "");
    expect(sql).toContain("target = $3::text");
    expect(sql).toContain("(record ->> 'channel') = $5::text");
    expect(sql).toContain("(record -> 'assignees') @> jsonb_build_array($6::text)");
    expect(sql).toContain("(record ->> 'externalRef') = $7::text");
    expect(sql).toContain("expires_at IS NOT NULL AND expires_at < $4::timestamptz");
    expect(sent[0]?.values).toEqual([
      "7",
      ["pending"],
      "refund",
      new Date("2026-01-05T10:00:00.000Z"),
      "slack",
      "ann",
      "JIRA-1",
      3,
    ]);
  });

  it("a filter that names nothing adds no condition", async () => {
    const { pool, sent } = poolAnswering();

    await new PauseScans(pool).ofAllTenants(PENDING, "0", 1);

    expect(sent[0]?.sql).not.toMatch(/assignees|externalRef|channel|target|expires_at/u);
  });
});

const READ = {
  tenant_id: "default",
  pause_id: "p",
  recipient: "listener:audit-listener",
  delivered: 0,
  attempts: 0,
  next_attempt_at: new Date("2026-01-05T09:00:00.000Z"),
  is_dead: false,
  problem: null,
  claim_token: "token",
  claimed_until: new Date("2026-01-05T09:05:00.000Z"),
};
const notice = (kind: string) => ({ seq: 1, kind, writtenAt: "2026-01-05T09:00:00.000Z" });

describe("the claim of mailboxes", () => {
  it("sets aside a row that does not read, and claims the others", async () => {
    const { pool, sent } = poolAnswering([
      [
        { ...READ, pause_id: "old", notices: [notice("extended")] },
        { ...READ, notices: [notice("opened")] },
      ],
    ]);

    const claims = await claimDue(pool, new Date("2026-01-05T09:00:00.000Z"), 10, 300_000, [
      "listener:audit-listener",
    ]);

    expect(claims.map((claim) => claim.mailbox.pauseId)).toEqual(["p"]);
    const aside = sent[1];
    expect(squeezed(aside?.sql ?? "")).toContain("SET is_dead = true, problem = $4");
    expect(aside?.values).toEqual([
      "default",
      "old",
      "listener:audit-listener",
      UNREADABLE_MAILBOX,
    ]);
  });

  it("a row whose key does not read either is the statement's failure, never swallowed", async () => {
    const { pool } = poolAnswering([[{ notices: [notice("opened")] }]]);

    // the row's own failure (the schema's), not a TypeError of reading a key that is not there
    await expect(claimDue(pool, new Date(), 10, 1, ["r"])).rejects.toBeInstanceOf(ZodError);
  });
});
