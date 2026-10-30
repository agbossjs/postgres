import type pg from "pg";
import { PostgresSchemaMissingError, PostgresSchemaTooNewError } from "../errors.js";
import { newestVersionOf, type MigrationFile } from "./files.js";
import { appliedVersionOf } from "./history.js";
import { migrateWith } from "./migrate.js";

/** What the start-up check is given: the database, its pool, the flag and the package's migrations. */
export interface SchemaCheck {
  readonly url: string;
  readonly pool: pg.Pool;
  readonly migrateOnStart: boolean;
  readonly files: readonly MigrationFile[];
}

/**
 * The start-up check of `PostgresConnection.onInit`: the newest migration applied against the
 * package's newest. Equal → nothing; newer → `PostgresSchemaTooNewError` (an application rolled
 * back over a migrated database); missing or older → migrated now when `migrateOnStart`, under
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
  if (!check.migrateOnStart) throw new PostgresSchemaMissingError({ applied, expected });
  await migrateWith({ url: check.url }, check.files);
}
