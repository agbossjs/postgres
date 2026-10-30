import { executionLeaseEventContract } from "@agboss/core/testing/contracts";
import { PostgresExecutionLeaseEventRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

const database = testDatabase();

executionLeaseEventContract(
  postgresTarget(database, (connection) => new PostgresExecutionLeaseEventRepository(connection)),
);
