import { pausedExecutionContract } from "@agboss/core/testing/contracts";
import { PostgresPausedExecutionRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

const database = testDatabase();

pausedExecutionContract(
  postgresTarget(
    database,
    (connection, seam) => new PostgresPausedExecutionRepository(connection, seam.clock),
  ),
);
