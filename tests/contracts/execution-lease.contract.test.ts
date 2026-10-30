import { executionLeaseContract } from "@agboss/core/testing/contracts";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

const database = testDatabase();

executionLeaseContract(
  postgresTarget(
    database,
    (connection, seam) =>
      new PostgresExecutionLeaseRepository(connection, seam.clock, seam.application),
  ),
);
