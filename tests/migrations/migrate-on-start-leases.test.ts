import { StoreClock } from "@agboss/core";
import { SchemaSetup } from "@agboss/core/stores";
import { seconds } from "@agboss/core/units";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  PostgresConnection,
  PostgresExecutionLeaseRepository,
  PostgresLiveLeasesError,
} from "../../src/index.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { leaseWaitFor } from "../../src/migrations/live-leases.js";
import { migrateWith, migratePostgres } from "../../src/migrations/migrate.js";
import { checkSchema } from "../../src/migrations/schema-check.js";
import { TestApplicationContext, revealing } from "../support/application-context.js";
import { freshSchema, onSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";
import { historyOf } from "../support/schema-dump.js";

/**
 * agbossjs/agboss#1104 (ADR-0034): no rolling upgrade across a schema change, `MigrateOnStart`
 * included. A start that has migrations to apply waits for the live execution leases to lapse (the
 * old instance stopped: its leases do) and fails with `PostgresLiveLeasesError` while one is live (the
 * old instance still renewing); `allowLiveLeases` keeps the override. Nothing to apply: no look.
 */
const FILES = migrationsIn();
const BEFORE_0033 = {
  "0033_pause_channel_generated.sql": null,
  "0034_cancel_mark_on_lease_row.sql": null,
  "0035_pause_reassignment.sql": null,
};
const NEWEST = "35:pause_reassignment";
const SHORT = { maxMs: 600, pollMs: 100, capMs: 600 };
const pools: pg.Pool[] = [];

afterAll(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

/** A database at 0032 and a lease of `holder` expiring in `ms` milliseconds on the server's clock. */
async function schemaWithLease(ms: number): Promise<string> {
  const url = await freshSchema();
  await migrateWith({ url }, migrationsIn(migrationsFolder(BEFORE_0033)));
  await onSchema(
    url,
    `INSERT INTO agboss_execution_leases
       (tenant_id, root_execution_id, holder_instance_id, token, expires_at, released)
     VALUES ('default', 'run-1', 'old-pod', 1, clock_timestamp() + ($1 || ' milliseconds')::interval, false)`,
    [String(ms)],
  );
  return url;
}

const startOf = (url: string, extra: object = {}): Promise<void> => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  pools.push(pool);
  return checkSchema({
    url,
    pool,
    schemaSetup: SchemaSetup.MigrateOnStart,
    files: FILES,
    leaseWait: SHORT,
    ...extra,
  });
};

describe("#1104: a start that migrates and the live leases", () => {
  it("a single instance upgraded: its stopped pod's lease lapses, the start waits, then migrates", async () => {
    const url = await schemaWithLease(1_500);

    await startOf(url, { leaseWait: { maxMs: 20_000, pollMs: 200 } });

    expect((await historyOf(url)).at(-1)).toBe(NEWEST);
  });

  it("a rolling restart, the old pod alive: refused with PostgresLiveLeasesError, nothing applied", async () => {
    const url = await schemaWithLease(3_600_000);

    const error = await startOf(url).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PostgresLiveLeasesError);
    expect(error).toMatchObject({ code: "postgres.live-leases", count: 1, holders: ["old-pod"] });
    expect((await historyOf(url)).at(-1)).toBe("32:execution_cancel_requests");
  });

  it("allowLiveLeases: the override migrates over the live lease at once", async () => {
    const url = await schemaWithLease(3_600_000);
    const connection = new PostgresConnection({
      url,
      schemaSetup: SchemaSetup.MigrateOnStart,
      allowLiveLeases: true,
    });

    await connection.onInit();
    await connection.onDestroy();

    expect((await historyOf(url)).at(-1)).toBe(NEWEST);
  });

  it("postgresAllowLiveLeases in the application's environment is the same override", async () => {
    const url = await schemaWithLease(3_600_000);
    const environment = {
      postgresUrl: revealing(url),
      postgresSchemaSetup: SchemaSetup.MigrateOnStart,
      postgresAllowLiveLeases: true,
    };
    const connection = new PostgresConnection(new TestApplicationContext(environment));

    await connection.onInit();
    await connection.onDestroy();

    expect((await historyOf(url)).at(-1)).toBe(NEWEST);
  });

  it("no migration pending: a restart with a live lease starts at once", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });
    await onSchema(
      url,
      `INSERT INTO agboss_execution_leases
         (tenant_id, root_execution_id, holder_instance_id, token, expires_at, released)
       VALUES ('default', 'run-1', 'pod', 1, clock_timestamp() + interval '1 hour', false)`,
    );

    await expect(startOf(url, { leaseWait: { maxMs: 1, pollMs: 1 } })).resolves.toBeUndefined();
  });

  it("a database with no migrations (the first start) has no leases to wait for", async () => {
    const url = await freshSchema();

    await startOf(url);

    expect((await historyOf(url)).at(-1)).toBe(NEWEST);
  });
});

describe("#1104: how long the start waits", () => {
  it("twice the lease left: a 45 s lease waits 90 s; the default is the floor; ten minutes the cap", () => {
    const defaults = { maxMs: 60_000, pollMs: 1_000 };

    expect(leaseWaitFor(45_000, defaults)).toBe(90_000);
    expect(leaseWaitFor(20_000, defaults)).toBe(60_000);
    expect(leaseWaitFor(0, defaults)).toBe(60_000);
    expect(leaseWaitFor(3_600_000, defaults)).toBe(600_000);
    expect(leaseWaitFor(3_600_000, { ...defaults, capMs: 120_000 })).toBe(120_000);
  });

  it("a lease longer than the floor is waited for: 5 s left, a 600 ms floor, the start still migrates", async () => {
    const url = await schemaWithLease(5_000);

    await startOf(url, { leaseWait: { maxMs: 600, pollMs: 100 } });

    expect((await historyOf(url)).at(-1)).toBe(NEWEST);
  });

  it("a lease past the cap is refused, not waited for", async () => {
    const url = await schemaWithLease(5_000);

    const error = await startOf(url, { leaseWait: { maxMs: 600, pollMs: 100, capMs: 800 } }).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(PostgresLiveLeasesError);
  });
});

/** A migration the build "has not applied yet": the schema is at the package's newest, this is one above. */
const NEXT = { "0036_next_for_1104.sql": "CREATE TABLE agboss_next_for_1104 (id integer)" };

/**
 * The old instance, for real: a running `PostgresConnection` and the lease store the core's holder
 * uses, taking a lease and renewing it as a holder does until it stops.
 */
class OldInstance {
  readonly connection: PostgresConnection;
  #renewal: NodeJS.Timeout | undefined;

  constructor(
    url: string,
    private readonly id: string,
  ) {
    this.connection = new PostgresConnection({ url, poolSize: 2 });
  }

  /** Starts, takes the lease of a run for 2 s and renews it every 200 ms. */
  async hold(): Promise<void> {
    await this.connection.onInit();
    const leases = new PostgresExecutionLeaseRepository(
      this.connection,
      new StoreClock(),
      new TestApplicationContext({}, this.id),
    );
    const held = await leases.acquire("default", "run-1", seconds(2));
    if (held === undefined) throw new Error("the old instance must take the lease");
    this.#renewal = setInterval(() => void leases.renew(held, seconds(2)), 200);
  }

  /** The instance stops: it renews no more (its last lease lapses on the database's clock). */
  async stop(): Promise<void> {
    clearInterval(this.#renewal);
    await this.connection.onDestroy();
  }
}

describe("#1104: a second instance holding a lease, the new build starting with MigrateOnStart", () => {
  it("refuses while the old instance renews, and migrates once it has stopped and its lease lapsed", async () => {
    const url = await freshSchema();
    await migratePostgres({ url });
    const next = migrationsIn(migrationsFolder(NEXT));
    const old = new OldInstance(url, "old-pod");
    await old.hold();

    const refused = await startOf(url, { files: next }).catch((reason: unknown) => reason);

    expect(refused).toBeInstanceOf(PostgresLiveLeasesError);
    expect(refused).toMatchObject({ count: 1, holders: ["old-pod"] });
    expect((await historyOf(url)).at(-1)).toBe(NEWEST);

    await old.stop();
    await startOf(url, { files: next, leaseWait: { maxMs: 30_000, pollMs: 200 } });

    expect((await historyOf(url)).at(-1)).toBe("36:next_for_1104");
  });
});
