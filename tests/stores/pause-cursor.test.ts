import { PauseResolution } from "@agboss/core";
import { NO_RECIPIENTS } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { onSchema, testDatabase } from "../support/database.js";
import { LATER, NINE, instanceOn, pauseOf } from "./pause-fixtures.js";

/**
 * agbossjs/agboss#936 (#935's finding): a page cursor is a position in the insertion sequence, and
 * the sequence is `bigserial` — never a reusable id. SQLite's `rowid` can give a deleted maximum
 * again, so a pause inserted after the removal of the last one sat at or before a cursor taken
 * earlier and was skipped; here it must come on the next page.
 */
const database = testDatabase();

const idsOf = (pauses: readonly { pauseId: string }[]): string[] =>
  pauses.map((pause) => pause.pauseId);

describe("a page cursor over the insertion sequence", () => {
  it("delete the maximum, then insert: the next page after an earlier cursor has the new pause", async () => {
    const store = instanceOn(database.url());
    for (const id of ["a", "b", "c", "d"]) await store.findOrCreateByStepKey(pauseOf(id));
    const first = await store.findOpenAfter(undefined, 3);
    expect(idsOf(first.pauses)).toEqual(["a", "b", "c"]);
    const maximum = await onSchema(database.url(), "SELECT max(seq) AS seq FROM agboss_pauses");

    for (const id of ["c", "d"])
      await store.cancelByTenantIdAndPauseId(
        "default",
        id,
        PauseResolution.Cancelled,
        NINE,
        NO_RECIPIENTS,
      );
    await store.deleteByResolvedAtBefore(LATER);
    await store.findOrCreateByStepKey(pauseOf("e"));

    const next = await store.findOpenAfter(first.next, 10);
    expect(idsOf(next.pauses)).toEqual(["e"]);
    const added = await onSchema(
      database.url(),
      "SELECT seq FROM agboss_pauses WHERE pause_id = 'e'",
    );
    expect(BigInt(String(added.rows[0]?.seq))).toBeGreaterThan(
      BigInt(String(maximum.rows[0]?.seq)),
    );
  });

  it("the sequence is an identity the table owns, not the id of a row", async () => {
    const { rows } = await onSchema(
      database.url(),
      `SELECT data_type, pg_get_serial_sequence('agboss_pauses', 'seq') AS sequence
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'agboss_pauses' AND column_name = 'seq'`,
    );

    expect(rows).toEqual([
      { data_type: "bigint", sequence: expect.stringContaining("agboss_pauses_seq_seq") },
    ]);
  });
});
