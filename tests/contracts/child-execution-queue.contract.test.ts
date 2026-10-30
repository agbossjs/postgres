import { childExecutionQueueContract } from "@agboss/core/testing/contracts";
import { PostgresChildExecutionQueueRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

const database = testDatabase();

childExecutionQueueContract(
  postgresTarget(
    database,
    (connection, seam) =>
      new PostgresChildExecutionQueueRepository(connection, seam.clock, seam.application),
  ),
);
