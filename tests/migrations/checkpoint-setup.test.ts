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
