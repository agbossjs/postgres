import { FencedEffectSettings } from "@agboss/core";
import { fencedEffectContract, type FencedEffectStores } from "@agboss/core/testing/contracts";
import type { PoolClient } from "pg";
import { beforeAll } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
} from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

/**
 * #500 on PostgreSQL: the effect store and the lease store of one database, and business rows the
 * effect's work inserts on the transaction's own connection — awaited, as a PostgreSQL work may.
 */
const database = testDatabase();

beforeAll(async () => {
  await onSchema(
    database.url(),
    "CREATE TABLE contract_rows (seq bigserial PRIMARY KEY, row text NOT NULL)",
  );
});

fencedEffectContract(
  postgresTarget(
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
          seam.clock,
          new FencedEffectSettings(),
        ),
        leases: new PostgresExecutionLeaseRepository(connection, seam.clock, seam.application),
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
  ),
);
