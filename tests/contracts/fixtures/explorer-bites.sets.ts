// agbossjs/agboss#590: the interleaving explorer bites on PostgreSQL — the two deliberately broken
// lease stores, each run through storeConformance by a fixture of its own (agbossjs/agboss#760: one
// sabotage per test file, explorer-bites-*.test.ts, each in a vitest of its own).
import { StoreClock, StoreTimeSource, type ExecutionLease } from "@agboss/core";
import { storeConformance } from "@agboss/core/testing/contracts";
import {
  PostgresExecutionLeaseRepository,
  PostgresOutboundCallRepository,
} from "../../../src/index.js";
import { testDatabase, truncateAll } from "../../support/database.js";
import { postgresStore } from "../postgres-store.js";

/** A lease store whose `retire` only releases: retired work is taken again (agbossjs/agboss#520). */
class ReleasingRetireLeases extends PostgresExecutionLeaseRepository {
  override retire(lease: ExecutionLease): Promise<void> {
    return this.release(lease);
  }
}

type Seam = Parameters<Parameters<typeof postgresStore>[1]>[1];
type Connection = Parameters<Parameters<typeof postgresStore>[1]>[0];
type LeasesOf = (
  connection: Connection,
  storeClock: StoreClock,
  seam: Seam,
) => PostgresExecutionLeaseRepository;

/** A set of the broken leases and the outbound-call store on them. */
function brokenSet(name: string, leasesOf: LeasesOf): void {
  const database = testDatabase();
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

export const FINISH_RELEASES = "a finish that only releases";
export const CALLER_CLOCK = "leases on the caller's clock";

/** `finish` only releases. */
export const finishReleasesSet = (): void => {
  brokenSet(
    FINISH_RELEASES,
    (connection, storeClock, seam) =>
      new ReleasingRetireLeases(connection, storeClock, seam.application),
  );
};

/** The caller's own (skewed) clock instead of the store's time: two live holders. */
export const callerClockSet = (): void => {
  brokenSet(
    CALLER_CLOCK,
    (connection, _storeClock, seam) =>
      new PostgresExecutionLeaseRepository(
        connection,
        new StoreClock(StoreTimeSource.Test, seam.clock),
        seam.application,
      ),
  );
};
