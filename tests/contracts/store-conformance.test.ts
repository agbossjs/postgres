import { FencedEffectSettings, RandomIdGenerator } from "@agboss/core";
import { storeConformance, type FencedEffectStores } from "@agboss/core/testing/contracts";
import type { PoolClient } from "pg";
import { beforeAll } from "vitest";
import {
  PostgresCheckpointSaver,
  PostgresChildExecutionQueueRepository,
  PostgresCostLedgerRepository,
  PostgresExecutionHistoryRepository,
  PostgresExecutionLeaseEventRepository,
  PostgresExecutionLeaseRepository,
  PostgresExecutionRecordRepository,
  PostgresExecutionTreeRepository,
  PostgresFencedEffectRepository,
  PostgresMeshRequestRepository,
  PostgresOutboundCallRepository,
  PostgresPausedExecutionRepository,
  PostgresRateLimitRepository,
} from "../../src/index.js";
import { onSchema, testDatabase, truncateAll } from "../support/database.js";
import { postgresStore } from "./postgres-store.js";

/**
 * Every PostgreSQL store through the core's `storeConformance` (agbossjs/agboss#526): the 13
 * published contract suites, each as `<contract> (PostgreSQL)`, and `store set (PostgreSQL)` —
 * the three fencing stores declare one backend. One schema for the file, emptied before each case.
 * Nothing is left out (`without`): this package has a store of every contract.
 */
const database = testDatabase();

beforeAll(async () => {
  // #500: the business rows a fenced effect's work inserts on the transaction's own connection
  await onSchema(
    database.url(),
    "CREATE TABLE contract_rows (seq bigserial PRIMARY KEY, row text NOT NULL)",
  );
});

/** The fenced-effect set: the effect and lease stores, and the work's business rows. */
const fencedEffects = postgresStore(
  database,
  async (connection, seam, onClose): Promise<FencedEffectStores<PoolClient>> => {
    // the reads of "another connection" on one already open: sent at once, when called
    const reader = await connection.pool.connect();
    onClose(() => {
      reader.release();
    });
    return {
      effects: new PostgresFencedEffectRepository(
        connection,
        seam.storeClock,
        new FencedEffectSettings(),
      ),
      leases: new PostgresExecutionLeaseRepository(connection, seam.storeClock, seam.application),
      rows: {
        insert: async (client, row) => {
          await client.query("INSERT INTO contract_rows (row) VALUES ($1)", [row]);
        },
        committed: async () => {
          const { rows } = await reader.query<{ row: string }>(
            "SELECT row FROM contract_rows ORDER BY seq",
          );
          return rows.map((found) => found.row);
        },
      },
    };
  },
);

storeConformance<PoolClient>({
  name: "PostgreSQL",
  reset: async () => {
    await truncateAll(database.url());
  },
  stores: {
    checkpointSaver: postgresStore(
      database,
      (connection) => new PostgresCheckpointSaver(connection),
    ),
    childExecutionQueue: postgresStore(
      database,
      (connection, seam) =>
        new PostgresChildExecutionQueueRepository(connection, seam.clock, seam.application),
    ),
    costLedger: postgresStore(
      database,
      (connection) => new PostgresCostLedgerRepository(connection),
    ),
    executionHistory: postgresStore(
      database,
      (connection) => new PostgresExecutionHistoryRepository(connection),
    ),
    executionLease: postgresStore(
      database,
      (connection, seam) =>
        new PostgresExecutionLeaseRepository(connection, seam.storeClock, seam.application),
    ),
    executionLeaseEvent: postgresStore(
      database,
      (connection) => new PostgresExecutionLeaseEventRepository(connection),
    ),
    executionRecord: postgresStore(
      database,
      (connection, seam) =>
        new PostgresExecutionRecordRepository(
          connection,
          seam.clock,
          seam.application,
          new RandomIdGenerator(),
        ),
    ),
    executionTree: postgresStore(
      database,
      (connection) => new PostgresExecutionTreeRepository(connection),
    ),
    fencedEffect: fencedEffects,
    meshRequest: postgresStore(
      database,
      (connection) => new PostgresMeshRequestRepository(connection),
    ),
    outboundCall: postgresStore(database, (connection, seam) => ({
      calls: new PostgresOutboundCallRepository(connection, seam.storeClock),
      leases: new PostgresExecutionLeaseRepository(connection, seam.storeClock, seam.application),
    })),
    pausedExecution: postgresStore(
      database,
      (connection, seam) => new PostgresPausedExecutionRepository(connection, seam.clock),
    ),
    rateLimit: postgresStore(
      database,
      (connection, seam) =>
        new PostgresRateLimitRepository(connection, seam.clock, seam.application),
    ),
  },
});
