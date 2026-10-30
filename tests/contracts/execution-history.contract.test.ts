import { executionHistoryContract } from "@agboss/core/testing/contracts";
import { PostgresExecutionHistoryRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

const database = testDatabase();

executionHistoryContract(
  postgresTarget(database, (connection) => new PostgresExecutionHistoryRepository(connection)),
);
