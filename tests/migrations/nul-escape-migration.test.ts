import { ExecutionRecordStatus } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresExecutionTreeRepository } from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { connectionTo, recordOf, recordsOn } from "../support/stores.js";

/**
 * agbossjs/agboss#521 AC4: migration 0013 — the rows a 0.1.0 store wrote hold no U+0000 but may hold
 * U+E000, the escape the stores now use: it is doubled, so those rows read back as they were.
 */
const ESCAPE = "";
const TREE = { tenantId: "default", rootExecutionId: "root-1" };

describe("AC4: migration 0013 keeps the rows written before it", () => {
  it("AC4: a record's task and a tree value with U+E000, written before 0013, read back unchanged", async () => {
    const url = await freshSchema();
    await migrateWith(
      { url },
      migrationsIn(
        migrationsFolder({
          "0013_nul_escape.sql": null,
          "0014_execution_lease_superseded.sql": null,
          "0015_fenced_effect_business_keys.sql": null,
          "0016_outbound_calls.sql": null,
          "0017_execution_lease_finished.sql": null,
          "0018_execution_ids.sql": null,
          "0019_execution_ids_from_outbound_calls.sql": null,
          "0020_pauses_by_tree.sql": null,
          "0021_pause_answers_by_tree.sql": null,
        }),
      ),
    );
    const records = recordsOn(url);
    const threadId = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });
    const { id } = await records.append(recordOf(threadId, ExecutionRecordStatus.Answered));
    await onSchema(url, "UPDATE agboss_execution_records SET task = $1, route = $2::jsonb", [
      `a ${ESCAPE}0 task`,
      JSON.stringify([`node ${ESCAPE}`]),
    ]);
    await onSchema(
      url,
      `INSERT INTO agboss_execution_tree_keys (tenant_id, root_execution_id, tree_key, value)
       VALUES ('default', 'root-1', 'plan', $1::jsonb)`,
      [JSON.stringify({ [`k${ESCAPE}`]: `v${ESCAPE}0` })],
    );

    await migratePostgres({ url });

    expect((await records.byIds([id]))[0]).toMatchObject({
      task: `a ${ESCAPE}0 task`,
      route: [`node ${ESCAPE}`],
    });
    const tree = new PostgresExecutionTreeRepository(connectionTo(url));
    expect(await tree.findByIdInTree(TREE, "plan")).toEqual({ [`k${ESCAPE}`]: `v${ESCAPE}0` });
  });
});
