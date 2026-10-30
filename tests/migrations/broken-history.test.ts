import { describe, expect, it } from "vitest";
import { migratePostgres, PostgresConnection } from "../../src/index.js";
import { freshSchema, onSchema } from "../support/database.js";

/** A history table that is not the package's fails loudly — never read as "no migrations". */
describe("an unreadable history", () => {
  it("the start check rethrows what is not a missing table", async () => {
    const url = await freshSchema();
    await onSchema(
      url,
      "CREATE TABLE agboss_schema_migrations (version text); INSERT INTO agboss_schema_migrations VALUES ('x')",
    );
    const connection = new PostgresConnection({ url });

    try {
      await expect(connection.onInit()).rejects.toThrow();
    } finally {
      await connection.onDestroy();
    }
  });

  it("LangGraph's history the same", async () => {
    const url = await freshSchema();
    await onSchema(
      url,
      "CREATE TABLE checkpoint_migrations (v text); INSERT INTO checkpoint_migrations VALUES ('x')",
    );

    await expect(migratePostgres({ url })).rejects.toThrow();
  });
});
