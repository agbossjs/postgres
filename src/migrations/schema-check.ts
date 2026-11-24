import { SchemaSetup } from "@agboss/core/stores";
import type pg from "pg";
import { PostgresSchemaMissingError, PostgresSchemaTooNewError } from "../errors.js";
import { newestVersionOf, type MigrationFile } from "./files.js";
import { appliedVersionOf } from "./history.js";
import { DEFAULT_LEASE_WAIT, waitForLeasesToLapse, type LeaseWait } from "./live-leases.js";
import { migrateWith } from "./migrate.js";

/** What the start-up check is given: the database, its schema and pool, the setup and the migrations. */
export interface SchemaCheck {
  readonly url: string;
  /** The schema the pool works in (unset: the URL's `search_path`). */
  readonly schema?: string | undefined;
  readonly pool: pg.Pool;
  readonly schemaSetup: SchemaSetup;
  readonly files: readonly MigrationFile[];
  /** Migrate over live execution leases (the settings' `allowLiveLeases`, agbossjs/agboss#1104). */
  readonly allowLiveLeases?: boolean | undefined;
  /** How long a migrating start waits for leases to lapse (a test's bound; default `DEFAULT_LEASE_WAIT`). */
  readonly leaseWait?: LeaseWait | undefined;
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
  const applied = await onClientOf(check.pool, (client) => appliedVersionOf(client));
  if (applied > expected) throw new PostgresSchemaTooNewError({ applied, expected });
  if (applied === expected) return;
  if (check.schemaSetup !== SchemaSetup.MigrateOnStart)
    throw new PostgresSchemaMissingError({ applied, expected });
  const allowLiveLeases = check.allowLiveLeases === true;
  // no rolling upgrade across a schema change (ADR-0034): with migrations pending on a migrated
  // schema the start waits for live leases to lapse and refuses while one is live; the migration
  // checks again under its lock (a lease taken meanwhile fails it too)
  if (applied > 0 && !allowLiveLeases) await leasesLapsed(check);
  await migrateWith(
    { url: check.url, schema: check.schema, allowLiveLeases },
    check.files,
    // the pod serves while the index builds (agbossjs/agboss#962)
    true,
  );
}

/** `waitForLeasesToLapse` on a connection of the pool. */
const leasesLapsed = (check: SchemaCheck): Promise<void> =>
  onClientOf(check.pool, (client) =>
    waitForLeasesToLapse(client, check.leaseWait ?? DEFAULT_LEASE_WAIT),
  );

/**
 * `work` on a connection of `pool`, given back after it. A dropped connection rejects the work's
 * statement and emits "error", which would throw with no listener; the pool drops a client that is
 * not queryable when it is given back.
 */
async function onClientOf<TResult>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await pool.connect();
  const onLost = (): undefined => undefined;
  client.on("error", onLost);
  try {
    return await work(client);
  } finally {
    client.off("error", onLost);
    client.release();
  }
}
