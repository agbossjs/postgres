import { outboundCallContract } from "@agboss/core/testing/contracts";
import {
  PostgresExecutionLeaseRepository,
  PostgresOutboundCallRepository,
} from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

/**
 * agbossjs/agboss#505, #508 on PostgreSQL: the outbound-call store and the lease store of one
 * database, two instances with a pool each — the races, the business keys and `leaseStateOf`.
 */
const database = testDatabase();

outboundCallContract(
  postgresTarget(database, (connection, seam) => ({
    calls: new PostgresOutboundCallRepository(connection, seam.clock),
    leases: new PostgresExecutionLeaseRepository(connection, seam.clock, seam.application),
  })),
);
