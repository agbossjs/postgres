import { RandomIdGenerator } from "@agboss/core";
import { executionRecordContract } from "@agboss/core/testing/contracts";
import { PostgresExecutionRecordRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

const database = testDatabase();

executionRecordContract(
  postgresTarget(
    database,
    (connection, seam) =>
      new PostgresExecutionRecordRepository(
        connection,
        seam.clock,
        seam.application,
        new RandomIdGenerator(),
      ),
  ),
);
