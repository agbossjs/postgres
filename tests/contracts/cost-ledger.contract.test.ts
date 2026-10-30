import { costLedgerContract } from "@agboss/core/testing/contracts";
import { PostgresCostLedgerRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

const database = testDatabase();

costLedgerContract(
  postgresTarget(database, (connection) => new PostgresCostLedgerRepository(connection)),
);
