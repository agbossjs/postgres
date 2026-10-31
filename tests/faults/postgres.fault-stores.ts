import type { Secret } from "@agboss/core";
import { secret } from "@agboss/core";
import type { FaultStores } from "@agboss/core/testing/faults";
import type { PoolClient } from "pg";
import {
  PostgresCheckpointSaver,
  PostgresChildExecutionQueueRepository,
  PostgresConnection,
  PostgresCostLedgerRepository,
  PostgresExecutionHistoryRepository,
  PostgresExecutionLeaseEventRepository,
  PostgresExecutionLeaseRepository,
  PostgresExecutionRecordRepository,
  PostgresExecutionTreeRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
  PostgresPausedExecutionRepository,
} from "../../src/index.js";

/**
 * agbossjs/agboss#484 — the PostgreSQL store set under the core's fault suite: every pod imports
 * this module (outside vitest: types only from `@agboss/core/testing/faults`) and lists every store
 * of the package on the scenario's schema (`AGBOSS_FAULT_DATABASE_URL`, through the pod's proxy).
 * The fixture's charge writes its business row in the fenced effect's transaction, on the
 * effect's own `PoolClient`.
 */

/** The environment the stores read: the database, a small pool per pod. */
export class PostgresFaultEnvironment {
  postgresUrl!: Secret;
  postgresPoolSize?: number;
}

/** The table of the fixture's business rows, created by each scenario's reset. */
export const FAULT_BUSINESS_ROWS_DDL = "CREATE TABLE fault_business_rows (row text NOT NULL)";

export const faultStores: FaultStores<PoolClient> = {
  providers: [
    PostgresConnection,
    PostgresCheckpointSaver,
    PostgresChildExecutionQueueRepository,
    PostgresCostLedgerRepository,
    PostgresExecutionHistoryRepository,
    PostgresExecutionLeaseEventRepository,
    PostgresExecutionLeaseRepository,
    PostgresExecutionRecordRepository,
    PostgresExecutionTreeRepository,
    PostgresFencedEffectRepository,
    PostgresOutboundCallRepository,
    PostgresPausedExecutionRepository,
  ],
  environment: {
    contract: PostgresFaultEnvironment,
    values: { postgresUrl: secret("AGBOSS_FAULT_DATABASE_URL"), postgresPoolSize: 4 },
  },
  businessRows: {
    insert: async (client, row) => {
      await client.query("INSERT INTO fault_business_rows (row) VALUES ($1)", [row]);
    },
    committed: async (app) => {
      const { rows } = await app
        .resolve(PostgresConnection)
        .pool.query<{ row: string }>("SELECT row FROM fault_business_rows ORDER BY ctid");
      return rows.map((found) => found.row);
    },
  },
};
