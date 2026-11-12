import { PauseAnswerer, PauseStatus } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import {
  PostgresExecutionHistoryRepository,
  PostgresPausedExecutionRepository,
} from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo, recordsOn } from "../support/stores.js";
import { oldAnswerLogEntry, oldHistoryRecord, oldPause } from "./pause-names-0.1.0.fixtures.js";

/**
 * agbossjs/agboss#934 AC3: what 0.1.0 kept in PostgreSQL reads back with the new names — rows
 * inserted as 0.1.0 wrote them (a contract case cannot: the writer rebuilds the JSON). A pause's
 * `answeredBy` (the kind) is its `answerer`, its answer's `answerer` (the person) is `answeredBy`,
 * a log entry's `answeredBy` / `responder` are `answerer` / `answeredBy`, a kept history record's
 * pauses and its children's the same. Nothing is migrated.
 */
const database = testDatabase();

describe("AC3: a PostgreSQL schema written by 0.1.0", () => {
  it("a Resolved pause's answer keeps its person (answeredBy) and its record says who may answer (answerer)", async () => {
    await onSchema(
      database.url(),
      `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status, resolved_at, record)
       VALUES ('default', 'p1', 'run-1:s:1', 'run-1', 'resolved', '2026-01-05T09:05:00Z', $1::jsonb)`,
      [JSON.stringify(oldPause)],
    );
    const pauses = new PostgresPausedExecutionRepository(
      connectionTo(database.url()),
      new VirtualClock(),
    );

    const pause = await pauses.findByTenantIdAndPauseId("default", "p1");

    expect(pause).toMatchObject({
      status: PauseStatus.Resolved,
      answerer: PauseAnswerer.Channel,
      answer: { decision: { approved: true }, answeredBy: "manager-17" },
    });
    expect(pause).not.toHaveProperty("answeredBy");
    expect(pause?.answer).not.toHaveProperty("answerer");
    expect(await pauses.findAllByTenantIdAndRootExecutionId("default", "run-1")).toMatchObject([
      { answerer: PauseAnswerer.Channel },
    ]);
  });

  it("a log entry: answerer = the kind, answeredBy the person", async () => {
    await onSchema(
      database.url(),
      `INSERT INTO agboss_pause_answers (tenant_id, root_execution_id, step_key, asked_at, record)
       VALUES ('default', 'run-1', 'run-1:s:1', '2026-01-05T09:00:00.000Z', $1)`,
      [JSON.stringify(oldAnswerLogEntry)],
    );

    const [entry] = await recordsOn(database.url()).findPauseAnswersByTenantIdAndRootExecutionId(
      "default",
      "run-1",
    );

    expect(entry).toMatchObject({
      answerer: PauseAnswerer.Channel,
      answeredBy: "manager-17",
      responder: "manager-17",
    });
  });

  it("a kept history record and its children's pauses are normalised", async () => {
    await onSchema(
      database.url(),
      `INSERT INTO agboss_execution_history (tenant_id, execution_id, thread_id, started_at, record)
       VALUES ('default', 'run-1', 't-1', '2026-01-05T09:00:00Z', $1::jsonb)`,
      [JSON.stringify(oldHistoryRecord)],
    );
    const history = new PostgresExecutionHistoryRepository(connectionTo(database.url()));

    const record = await history.findByTenantIdAndExecutionId("default", "run-1");

    expect([
      record?.pauses[0],
      record?.children[0]?.pauses[0],
      record?.children[0]?.children[0]?.pauses[0],
    ]).toMatchObject([
      { answerer: PauseAnswerer.Channel, answeredBy: "manager-17" },
      { answerer: PauseAnswerer.ThreadOwner, answeredBy: "alice" },
      { answerer: PauseAnswerer.Channel, answeredBy: "bob" },
    ]);
  });
});
