// agbossjs/agboss#590: the interleaving explorer bites on PostgreSQL — two deliberately broken lease
// stores run through storeConformance (in a vitest of its own, explorer-bites.test.ts).
import type { ExecutionLease, StoreClock } from "@agboss/core";
import { TestStoreClock } from "@agboss/core/testing";
import { storeConformance } from "@agboss/core/testing/contracts";
import {
  PostgresExecutionLeaseRepository,
  PostgresOutboundCallRepository,
} from "../../../src/index.js";
import { testDatabase, truncateAll } from "../../support/database.js";
import { postgresStore } from "../postgres-store.js";

/** A lease store whose `finish` only releases: finished work is taken again (agbossjs/agboss#520). */
class ReleasingFinishLeases extends PostgresExecutionLeaseRepository {
  override finish(lease: ExecutionLease): Promise<void> {
    return this.release(lease);
  }
}

const database = testDatabase();

/** A set of the broken leases and the outbound-call store on them. */
function brokenSet(name: string, leasesOf: typeof makeLeases): void {
  storeConformance({
    name,
    reset: async () => {
      await truncateAll(database.url());
    },
    without: ["fencedEffect", "executionLeaseEvent"],
    interleavings: { depth: 4, walks: 20, walkDepth: 20 },
    stores: {
      executionLease: postgresStore(database, (connection, seam) =>
        leasesOf(connection, seam.storeClock, seam),
      ),
      outboundCall: postgresStore(database, (connection, seam) => {
        const leases = leasesOf(connection, seam.storeClock, seam);
        return { calls: new PostgresOutboundCallRepository(connection, seam.storeClock), leases };
      }),
    },
  });
}

type Seam = Parameters<Parameters<typeof postgresStore>[1]>[1];
type Connection = Parameters<Parameters<typeof postgresStore>[1]>[0];

const makeLeases = (
  connection: Connection,
  storeClock: StoreClock,
  seam: Seam,
): PostgresExecutionLeaseRepository =>
  new PostgresExecutionLeaseRepository(connection, storeClock, seam.application);

brokenSet(
  "a finish that only releases",
  (connection, storeClock, seam) =>
    new ReleasingFinishLeases(connection, storeClock, seam.application),
);
// the caller's own (skewed) clock instead of the store's time: two live holders
brokenSet("leases on the caller's clock", (connection, _storeClock, seam) =>
  makeLeases(connection, new TestStoreClock(seam.clock), seam),
);
