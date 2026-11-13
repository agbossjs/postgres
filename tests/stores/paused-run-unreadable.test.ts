import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { PostgresPausedExecutionRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { oldPausedRun } from "./pause-names-0.1.0.fixtures.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#906 D4: a paused run stored by 0.1.0 names its record `ternId` — read as
 * `turnId` (as the SQLite store does); a stored run that cannot be read is refused by its ids and
 * the field that failed, the schema's error its `cause` — never with the run in the message, whose
 * `startInput` and `data` are the caller's (PII reaches the logs through a message).
 */
const database = testDatabase();
const SECRET = "ssn-078-05-1120";

const pausesOn = (): PostgresPausedExecutionRepository =>
  new PostgresPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

const run = {
  ...oldPausedRun,
  threadId: "thread-1",
  tenantId: "acme",
  runId: "run-1",
  turnId: "turn-1",
  ternId: undefined,
  startInput: { ssn: SECRET },
  data: { ...Object(oldPausedRun.data), note: SECRET },
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
  it("a run stored by 0.1.0 under `ternId` is read as `turnId`, and resumes from there", async () => {
    const { turnId, ...rest } = run;
    await insertRun({ ...rest, ternId: turnId });

    const found = await pausesOn().findByTenantIdAndThreadId("acme", "thread-1");

    expect(found?.run).toMatchObject({ turnId: "turn-1", runId: "run-1", tenantId: "acme" });
    expect(found?.run).not.toHaveProperty("ternId");
  });

  it("a run written whole by 0.1.0 (a typed literal against the published declarations) is read: its pending pause has the new names", async () => {
    await insertRun({ ...oldPausedRun, threadId: "thread-1", runId: "run-1", tenantId: "acme" });

    const found = await pausesOn().findByTenantIdAndThreadId("acme", "thread-1");

    expect(found?.run).toMatchObject({ turnId: "turn-1", cost: { unknownCalls: 0 } });
    expect(found?.run.pending[0]).toMatchObject({
      kind: "approval",
      step: "clerk-agent",
      answerer: "channel",
      answeredBy: "channel",
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

  it("a stored text that is not JSON is refused by ids: no text, no parser message, no cause", async () => {
    // one character of a real stored run edited: the secret loses its quotes
    await insertRun(JSON.stringify(run).replace(`"${SECRET}"`, SECRET));

    const error = await failureOf();

    expect(error.message).toContain("a stored paused run is not readable");
    expect(error.message).toContain("threadId thread-1");
    expect(error.message).toContain("runId run-1");
    expect(error).not.toBeInstanceOf(SyntaxError);
    for (let link: unknown = error; link instanceof Error; link = link.cause) {
      expect(link.message).not.toContain(SECRET);
      expect(link.message).not.toContain("startInput");
      expect(link.message).not.toContain("JSON.parse");
      expect(link).not.toBeInstanceOf(SyntaxError);
    }
  });
});
