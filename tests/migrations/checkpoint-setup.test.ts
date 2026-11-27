import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { migratePostgres } from "../../src/index.js";
import { createSchema, dropSchema, onSchema } from "../support/database.js";

/**
 * LangGraph's own migrations (`PostgresSaver.setup()`): the report counts how many of them a run
 * applied, from the newest one in `checkpoint_migrations` before and after.
 */
const schemas: string[] = [];
afterEach(async () => {
  for (const schema of schemas.splice(0)) await dropSchema(schema);
});

async function fresh(): Promise<string> {
  const made = await createSchema();
  schemas.push(made.schema);
  return made.url;
}

describe("LangGraph's checkpoint migrations in the report", () => {
  it("an empty checkpoint_migrations counts as none applied: every one of them is counted", async () => {
    const counted = (await migratePostgres({ url: await fresh() })).checkpointMigrations;
    const url = await fresh();
    await onSchema(url, "CREATE TABLE checkpoint_migrations (v INTEGER PRIMARY KEY)");

    const report = await migratePostgres({ url });

    expect(report.checkpointMigrations).toBe(counted);
    expect(counted).toBeGreaterThan(1);
  });
});

describe("the root id step of the checkpoint tables (agbossjs/agboss#1321d, #962)", () => {
  it("a run that finds it applied takes no lock on the tables: it does not wait for a concurrent index build", async () => {
    const url = await fresh();
    await migratePostgres({ url });
    // what `CREATE INDEX CONCURRENTLY` of another run holds on the table for its whole build
    const builder = new pg.Client({ connectionString: url });
    await builder.connect();
    try {
      await builder.query("BEGIN");
      await builder.query("LOCK TABLE checkpoints IN SHARE UPDATE EXCLUSIVE MODE");

      // an ACCESS EXCLUSIVE `ALTER TABLE` would wait for the builder, which commits only after it
      const second = await Promise.race([
        migratePostgres({ url }).then(() => "done"),
        new Promise((resolve) => {
          setTimeout(() => {
            resolve("waiting");
          }, 8000);
        }),
      ]);

      expect(second).toBe("done");
    } finally {
      await builder.query("ROLLBACK").catch(() => undefined);
      await builder.end();
    }
  });

  it("a schema missing the trigger gets all three parts again", async () => {
    const url = await fresh();
    await migratePostgres({ url });
    await onSchema(url, "DROP TRIGGER agboss_checkpoints_root ON checkpoints");

    await migratePostgres({ url });

    const { rows } = await onSchema(
      url,
      "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'agboss_checkpoints_root' AND tgrelid = 'checkpoints'::regclass",
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});
