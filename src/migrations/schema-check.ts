import { SchemaSetup } from "@agboss/core/stores";
import type pg from "pg";
import { PostgresSchemaMissingError, PostgresSchemaTooNewError } from "../errors.js";
import { newestVersionOf, type MigrationFile } from "./files.js";
import { appliedVersionOf } from "./history.js";
import { migrateWith } from "./migrate.js";

/** What the start-up check is given: the database, its schema and pool, the setup and the migrations. */
export interface SchemaCheck {
  readonly url: string;
  /** The schema the pool works in (unset: the URL's `search_path`). */
  readonly schema?: string | undefined;
  readonly pool: pg.Pool;
  readonly schemaSetup: SchemaSetup;
  readonly files: readonly MigrationFile[];
}

/**
 * The start-up check of `PostgresConnection.onInit`: the newest migration applied against the
 * package's newest. Equal → nothing; newer → `PostgresSchemaTooNewError` (an application rolled
 * back over a migrated database); missing or older → migrated now under `SchemaSetup.MigrateOnStart`, under
 * the migrations' lock (another instance migrating meanwhile is waited for), else
 * `PostgresSchemaMissingError`, which names the command.
 */
export async function checkSchema(check: SchemaCheck): Promise<void> {
  const expected = newestVersionOf(check.files);
  const client = await check.pool.connect();
  // a dropped connection rejects the read below; it is not given back to the pool
  let isLost = false;
  const onLost = (): void => {
    isLost = true;
  };
  client.on("error", onLost);
  let applied: number;
  try {
    applied = await appliedVersionOf(client);
  } finally {
    client.off("error", onLost);
    client.release(isLost);
  }
  if (applied > expected) throw new PostgresSchemaTooNewError({ applied, expected });
  if (applied === expected) return;
  if (check.schemaSetup !== SchemaSetup.MigrateOnStart)
    throw new PostgresSchemaMissingError({ applied, expected });
  await migrateWith(
    check.schema === undefined ? { url: check.url } : { url: check.url, schema: check.schema },
    check.files,
  );
}
