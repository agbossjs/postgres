import { meshRequestContract } from "@agboss/core/testing/contracts";
import { PostgresMeshRequestRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

const database = testDatabase();

meshRequestContract(
  postgresTarget(database, (connection) => new PostgresMeshRequestRepository(connection)),
);
