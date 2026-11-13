/**
 * agbossjs/agboss#934 D1 / D2: a stored value that is neither the 0.1.0 shape nor the new one is
 * refused — in the history record (its pauses and its children's, at any depth), in the answer log
 * and in a pause's embedded answer alike — with `StoredNamesUnreadableError` naming the record's id
 * and the field, never the value. Rows are inserted as a damaged database would hold them.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  PostgresExecutionHistoryRepository,
  PostgresPausedExecutionRepository,
} from "../../src/index.js";
import { VirtualClock } from "@agboss/core/testing";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo, recordsOn } from "../support/stores.js";
import {
  historyRecordWith,
  leafOf,
  oldAnswer,
  oldHistoryRecord,
  oldPause,
} from "./pause-names-0.1.0.fixtures.js";

const database = testDatabase();
const SECRET = "sk-live-PLANTED-SECRET-934";

/** Everything an error shows: message, stack, the whole cause chain. */
const shown = (error: unknown): string => inspect(error, { depth: 12 });

/** The refusal of `read`: the typed error, its message naming `id` and `field`, no value anywhere. */
async function refusal(read: () => unknown, id: string, field: string): Promise<void> {
  const error = await Promise.resolve()
    .then(read)
    .then(
      () => new Error("it was read"),
      (thrown: unknown) => thrown,
    );
  if (!(error instanceof Error)) throw new TypeError("nothing was thrown");
  expect(error.name).toBe("StoredNamesUnreadableError");
  expect(error.message).toContain(id);
  expect(error.message).toContain(field);
  expect(shown(error)).not.toContain(SECRET);
  expect(shown(error)).not.toContain("<junk>");
}

const entry = (change: Record<string, unknown>): unknown => ({
  ...oldAnswer("run-1", "channel", "manager-17"),
  ...change,
});

/** Entries neither shape accepts, with the field the refusal names. */
const BAD_ENTRIES: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ["a 0.1.0 entry with a junk answerer", { answerer: "<junk>" }, "answerer"],
  [
    "a new entry whose answeredBy is an object",
    { answerer: "channel", answeredBy: { t: SECRET } },
    "answeredBy",
  ],
  [
    "a new entry whose answeredBy is a number",
    { answerer: "channel", answeredBy: 42 },
    "answeredBy",
  ],
  ["a 0.1.0 entry whose answeredBy is no kind", { answeredBy: SECRET }, "answeredBy"],
  ["a 0.1.0 entry whose responder is a number", { responder: 42 }, "responder"],
  ["a 0.1.0 entry whose responder is an object", { responder: { t: SECRET } }, "responder"],
];

const historyWith = async (record: unknown): Promise<PostgresExecutionHistoryRepository> => {
  await onSchema(
    database.url(),
    "DELETE FROM agboss_execution_history WHERE tenant_id = 'default' AND execution_id = 'run-1'",
  );
  await onSchema(
    database.url(),
    `INSERT INTO agboss_execution_history (tenant_id, execution_id, thread_id, started_at, record)
     VALUES ('default', 'run-1', 't-1', '2026-01-05T09:00:00Z', $1::jsonb)`,
    [JSON.stringify(record)],
  );
  return new PostgresExecutionHistoryRepository(connectionTo(database.url()));
};

const answerLogWith = async (record: unknown): Promise<string> => {
  const root = `root-${String(Math.random()).slice(2)}`;
  await onSchema(
    database.url(),
    `INSERT INTO agboss_pause_answers (tenant_id, root_execution_id, step_key, asked_at, record)
     VALUES ('default', $1, 'run-1:s:1', '2026-01-05T09:00:00.000Z', $2)`,
    [root, JSON.stringify(record)],
  );
  return root;
};

describe("D1: the same entry is refused on the history path and on the answer-log path", () => {
  it.each(BAD_ENTRIES)("%s", async (_name, change, field) => {
    const bad = entry(change);
    const history = await historyWith({ ...oldHistoryRecord, pauses: [bad] });
    const root = await answerLogWith(bad);

    await refusal(
      () => history.findByTenantIdAndExecutionId("default", "run-1"),
      "run-1",
      `pauses.0.${field}`,
    );
    await refusal(
      () => recordsOn(database.url()).findPauseAnswersByTenantIdAndRootExecutionId("default", root),
      "run-1",
      field,
    );
  });

  it("an entry a child's child holds is refused at its path", async () => {
    const history = await historyWith(
      historyRecordWith((tree) => {
        leafOf(tree).pauses = [entry({ answerer: "<junk>" })];
      }),
    );

    await refusal(
      () => history.findAllByExecutionId("run-1"),
      "run-1",
      "children.0.children.0.pauses.0.answerer",
    );
  });
});

describe("D2: an unreadable history record names its id and the field, nothing else", () => {
  it.each([
    ["a null entry", { pauses: [null] }, "pauses.0"],
    ["an entry that is a text", { pauses: [SECRET] }, "pauses.0"],
    ["a status that is an object", { status: { t: SECRET } }, "status"],
    ["a startedAt that is a number", { startedAt: 42 }, "startedAt"],
    ["a spend that is a text", { spend: SECRET }, "spend"],
    ["a step that is a number", { steps: [42] }, "steps.0"],
  ])("%s", async (_name, change, field) => {
    const history = await historyWith({ ...oldHistoryRecord, ...change });

    await refusal(() => history.findByTenantIdAndExecutionId("default", "run-1"), "run-1", field);
  });
});

describe("D1 / D2: a pause's embedded answer and the answer log", () => {
  const pauseWith = async (
    answer: unknown,
    id: string,
  ): Promise<PostgresPausedExecutionRepository> => {
    await onSchema(
      database.url(),
      `INSERT INTO agboss_pauses (tenant_id, pause_id, step_key, root_execution_id, status, resolved_at, record)
       VALUES ('default', $1, $2, 'run-1', 'resolved', '2026-01-05T09:05:00Z', $3::jsonb)`,
      [id, `run-1:s:${id}`, JSON.stringify({ ...oldPause, pauseId: id, answer })],
    );
    return new PostgresPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());
  };

  it.each([
    ["an answerer that is an object", { decision: 1, answerer: { t: SECRET } }, "answer.answerer"],
    ["an answeredBy that is a number", { decision: 1, answeredBy: 42 }, "answer.answeredBy"],
    ["a text instead of the answer", SECRET, "answer"],
  ])("a pause whose answer has %s names the pause and the field", async (_name, answer, field) => {
    const id = `p-${String(Math.random()).slice(2, 8)}`;
    const pauses = await pauseWith(answer, id);

    await refusal(() => pauses.findByTenantIdAndPauseId("default", id), `pauseId ${id}`, field);
  });

  it("an answer-log entry whose role is an object names the execution and the field", async () => {
    const root = await answerLogWith(entry({ role: { t: SECRET } }));

    await refusal(
      () => recordsOn(database.url()).findPauseAnswersByTenantIdAndRootExecutionId("default", root),
      "run-1",
      "role",
    );
  });
});
