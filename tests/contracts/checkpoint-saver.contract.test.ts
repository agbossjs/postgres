import { checkpointSaverContract } from "@agboss/core/testing/contracts";
import { PostgresCheckpointSaver } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

const database = testDatabase();

checkpointSaverContract(
  postgresTarget(database, (connection) => new PostgresCheckpointSaver(connection)),
);
