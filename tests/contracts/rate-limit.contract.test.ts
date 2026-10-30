import { rateLimitContract } from "@agboss/core/testing/contracts";
import { PostgresRateLimitRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { postgresTarget } from "./postgres-target.js";

const database = testDatabase();

rateLimitContract(
  postgresTarget(
    database,
    (connection, seam) => new PostgresRateLimitRepository(connection, seam.clock, seam.application),
  ),
);
