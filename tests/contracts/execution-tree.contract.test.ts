import { executionTreeContract } from "@agboss/core/testing/contracts";
import { PostgresExecutionTreeRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

const database = testDatabase();

executionTreeContract(
  postgresTarget(database, (connection) => new PostgresExecutionTreeRepository(connection)),
);
