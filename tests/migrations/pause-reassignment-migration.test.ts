import { describe, expect, it } from "vitest";
import { migratePostgres } from "../../src/index.js";
import { freshSchema, onSchema } from "../support/database.js";

/**
 * agbossjs/agboss#946: migration 0035 adds the partial index of the re-send look — keyed
 * `(askedAt, tenant, pause)`, the scan's order and its keyset, over the pending, unsent, reassigned
 * rows only — and no column (the fields live in the record). A run again changes nothing.
 */
describe("migration 0035: the reassigned-unsent index", () => {
  it("the index is keyed like the scan, partial on pending unsent replacements; the scan uses it", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });

    const { rows } = await onSchema(
      url,
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'agboss_pauses'
         AND indexname = 'agboss_pauses_reassigned_unsent'`,
    );
    const definition = String((rows[0] as { indexdef: string } | undefined)?.indexdef);
    expect(definition).toMatch(
      /askedAt'::text\)+ COLLATE "C", tenant_id COLLATE "C", pause_id COLLATE "C"\)/u,
    );
    expect(definition).toMatch(/WHERE .*status = 'pending'.*reassignedFrom.*isSent/su);
    const again = await migratePostgres({ url });
    expect(again.applied).toEqual([]);
  });
});
