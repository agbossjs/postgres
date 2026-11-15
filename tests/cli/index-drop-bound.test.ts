/**
 * #1116: the drop of an INVALID index (after a cancelled build, or at the start of the next run)
 * never makes `migrate` wait for another transaction. `DROP INDEX CONCURRENTLY` waits for every
 * transaction that holds a lock on `checkpoints`, an idle reader included; it runs under a short
 * `lock_timeout`, leaves the INVALID index for the next run, says so, and the run ends at once.
 * It stays `CONCURRENTLY`: no write to `checkpoints` waits for it.
 */
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { ExitCode, runCommand } from "../../src/cli.js";
import { migratePostgres } from "../../src/index.js";
import {
  DROP_LOCK_TIMEOUT_MS,
  dropInvalid,
  STEP_INDEX_NAME,
} from "../../src/migrations/checkpoint-step-index.js";
import { createSchema, dropSchema, onSchema } from "../support/database.js";
import {
  cancelBuild,
  closeHolders,
  holdReader,
  holdSnapshot,
  ioOf,
  validityOf,
  writeWhileDropWaits,
} from "../support/step-index.js";

/** What a run may take beyond the drop's own bound: the migrations, the cancel, the connections. */
const BOUND_MS = DROP_LOCK_TIMEOUT_MS + 8000;

const schemas: string[] = [];
afterEach(async () => {
  await closeHolders();
  for (const schema of schemas.splice(0)) await dropSchema(schema);
});

async function migrated(): Promise<{ readonly schema: string; readonly url: string }> {
  const made = await createSchema();
  schemas.push(made.schema);
  await migratePostgres({ url: made.url });
  return made;
}

const markInvalid = (url: string, schema: string) =>
  onSchema(url, `UPDATE pg_index SET indisvalid = false WHERE indexrelid = $1::regclass`, [
    `${schema}.${STEP_INDEX_NAME}`,
  ]);

const STAYS =
  "an INVALID index checkpoints_latest_by_step stays: the next migrate run drops and rebuilds it";

describe("#1116 AC1: a cancelled build, another transaction holds a lock on checkpoints", () => {
  for (const isolation of ["READ COMMITTED", "REPEATABLE READ"] as const)
    it(`AC1: a reader idle in a ${isolation} transaction: exit 1 within the bound, the build's cause, the INVALID index named; the next run rebuilds it`, async () => {
      const { schema, url } = await migrated();
      await onSchema(url, `DROP INDEX ${STEP_INDEX_NAME}`);
      const reader = await holdReader(url, isolation);
      // a build waits for an old snapshot and can be cancelled while it waits
      await holdSnapshot(url);
      const io = ioOf();
      const started = performance.now();

      const [code, written] = await Promise.all([
        runCommand(["migrate", "--url", url], io),
        cancelBuild(schema).then(() => writeWhileDropWaits(url, schema)),
      ]);

      expect(performance.now() - started).toBeLessThan(BOUND_MS);
      expect(code).toBe(ExitCode.Failed);
      expect(io.err_).toHaveLength(1);
      // the build's cause is the run's: the drop's own lock timeout does not replace it
      expect(io.err_[0]).toContain("failed: canceling statement due to user request");
      expect(io.err_[0]).not.toContain("lock timeout");
      expect(io.err_[0]).toContain(STAYS);
      // the reader is still in its transaction: the run did not wait for it, and left the INVALID index
      expect((await reader.query("SELECT 1 AS alive")).rows).toEqual([{ alive: 1 }]);
      expect(await validityOf(url)).toBe(false);
      // AC2: the drop that waited was CONCURRENTLY, and no write waited for it
      expect(written.dropQuery).toMatch(/^DROP INDEX CONCURRENTLY /);
      expect(written.writeMs).toBeLessThan(DROP_LOCK_TIMEOUT_MS / 2);

      await closeHolders();
      const next = await migratePostgres({ url });
      expect(next.stepIndex).toBe("built");
      expect(await validityOf(url)).toBe(true);
    }, 60_000);
});

describe("#1116 AC1: the INVALID index of an earlier run, another transaction holds a lock on checkpoints", () => {
  it("AC1: the drop at the start of the run gives up in the bound: exit 1, the lock timeout named, the index left, nothing built over it", async () => {
    const { schema, url } = await migrated();
    await markInvalid(url, schema);
    const reader = await holdReader(url, "READ COMMITTED");
    const io = ioOf();
    const started = performance.now();

    const [code, written] = await Promise.all([
      runCommand(["migrate", "--url", url], io),
      writeWhileDropWaits(url, schema),
    ]);

    expect(performance.now() - started).toBeLessThan(BOUND_MS);
    expect(code).toBe(ExitCode.Failed);
    expect(io.err_).toHaveLength(1);
    expect(io.err_[0]).toContain("failed: canceling statement due to lock timeout");
    expect(io.err_[0]).toContain(STAYS);
    expect((await reader.query("SELECT 1 AS alive")).rows).toEqual([{ alive: 1 }]);
    expect(await validityOf(url)).toBe(false);
    // AC2: CONCURRENTLY here too: a plain DROP INDEX would hold this write until the timeout
    expect(written.dropQuery).toMatch(/^DROP INDEX CONCURRENTLY /);
    expect(written.writeMs).toBeLessThan(DROP_LOCK_TIMEOUT_MS / 2);

    await closeHolders();
    expect((await migratePostgres({ url })).stepIndex).toBe("built");
    expect(await validityOf(url)).toBe(true);
  }, 60_000);
});

describe("#1116: dropInvalid", () => {
  async function session(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return client;
  }

  it("a VALID index is never dropped, an INVALID one is, and nothing it fails on is thrown", async () => {
    const { schema, url } = await migrated();
    const client = await session(url);
    try {
      expect(await dropInvalid(client, schema)).toBe(true);
      expect(await validityOf(url)).toBe(true);

      await markInvalid(url, schema);
      expect(await dropInvalid(client, schema)).toBe(true);
      expect(await validityOf(url)).toBeUndefined();
      // nothing left to drop
      expect(await dropInvalid(client, schema)).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("a drop that cannot finish in the bound answers false and throws nothing; the session stays usable", async () => {
    const { schema, url } = await migrated();
    await markInvalid(url, schema);
    await holdReader(url, "READ COMMITTED");
    const client = await session(url);
    try {
      expect(await dropInvalid(client, schema)).toBe(false);
      expect(await validityOf(url)).toBe(false);
      // the bound was the statement's own: the session's lock_timeout is back to none
      expect((await client.query("SHOW lock_timeout")).rows).toEqual([{ lock_timeout: "0" }]);
    } finally {
      await client.end();
    }
  }, 30_000);
});
