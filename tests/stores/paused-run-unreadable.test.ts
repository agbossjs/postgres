import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { PostgresPausedExecutionRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { pausedRun } from "./stored-rows.fixtures.js";
import { connectionTo } from "../support/stores.js";
import { StoreError } from "@agboss/core/stores";

/**
 * agbossjs/agboss#906 D4: a stored run that cannot be read (as the SQLite store reads it) is refused by its ids and
 * the field that failed, the schema's error its `cause` — never with the run in the message, whose
 * `startInput` and `data` are the caller's (PII reaches the logs through a message).
 */
const database = testDatabase();
const SECRET = "ssn-078-05-1120";

const pausesOn = (): PostgresPausedExecutionRepository =>
  new PostgresPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

const run = {
  ...pausedRun,
  threadId: "thread-1",
  tenantId: "acme",
  runId: "run-1",
  turnId: "turn-1",
  startInput: { ssn: SECRET },
  data: { ...Object(pausedRun.data), note: SECRET },
};

/** The thread's stored run as `stored` (a document no store write makes). */
async function insertRun(stored: object | string): Promise<void> {
  await onSchema(database.url(), "DELETE FROM agboss_paused_executions");
  await onSchema(
    database.url(),
    `INSERT INTO agboss_paused_executions VALUES ('acme', 'thread-1', 'run-1', $1, '1.0.0', 'hash', now())`,
    [typeof stored === "string" ? stored : JSON.stringify(stored)],
  );
}

const failureOf = async (): Promise<Error> => {
  const thrown: unknown = await pausesOn()
    .findByTenantIdAndThreadId("acme", "thread-1")
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(thrown).toBeInstanceOf(Error);
  return thrown as Error;
};

describe("agbossjs/agboss#906 D4: PostgreSQL paused runs", () => {
  it("a run written whole is read: its pending pause has the 0.1.1 names", async () => {
    await insertRun({ ...pausedRun, threadId: "thread-1", runId: "run-1", tenantId: "acme" });

    const found = await pausesOn().findByTenantIdAndThreadId("acme", "thread-1");

    expect(found?.run).toMatchObject({ turnId: "turn-1", cost: { unknownCalls: 0 } });
    expect(found?.run.pending[0]).toMatchObject({
      kind: "approval",
      step: "clerk-agent",
      target: "refund-tool-approval",
      respondent: "delegate",
    });
  });

  it("a run without any record id is refused by ids and field: the message carries no input value", async () => {
    await insertRun(Object.fromEntries(Object.entries(run).filter(([key]) => key !== "turnId")));

    const error = await failureOf();

    expect(error.message).toContain("a stored paused run is not readable");
    expect(error.message).not.toContain("tenantId");
    expect(error.message).toContain("threadId thread-1");
    expect(error.message).toContain("runId run-1");
    expect(error.message).toContain("the field(s) turnId");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("startInput");
  });

  it("another failing field is named, and the schema's error is the cause", async () => {
    await insertRun({ ...run, status: "answered" });

    const error = await failureOf();

    expect(error.message).toContain("the field(s) status");
    expect(error.message).not.toContain(SECRET);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).not.toContain(SECRET);
  });

  it("a stored text that is not JSON is the coded refusal (#1121): ids, no text, no parser message", async () => {
    // one character of a real stored run edited: the secret loses its quotes
    await insertRun(JSON.stringify(run).replace(`"${SECRET}"`, SECRET));

    const error = await failureOf();

    expect(error.message).toContain("a stored paused run is not readable");
    expect(error.message).toContain("threadId thread-1");
    expect(error.message).toContain("runId run-1");
    expect(error).toBeInstanceOf(StoreError.UnreadableRecord);
    expect(error).toMatchObject({ code: "store.unreadable-record", record: "paused run" });
    // the cause is the parse's SyntaxError without the text it quotes
    expect(error.cause).toBeInstanceOf(SyntaxError);
    for (let link: unknown = error; link instanceof Error; link = link.cause) {
      expect(link.message).not.toContain(SECRET);
      expect(link.message).not.toContain("startInput");
      expect(link.message).not.toContain("JSON.parse");
      expect(link.message).not.toContain("Unexpected");
    }
  });
});
