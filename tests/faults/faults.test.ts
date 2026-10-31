import { faultSuite } from "@agboss/core/testing/faults";
import { postgresFaultTarget } from "./postgres-target.js";

/**
 * agbossjs/agboss#484 AC2, AC4 — every scenario of the core's fault suite on PostgreSQL: real
 * `node` pods on one database, killed, stopped, frozen and cut off it, every invariant checked
 * after each (`npm run test:faults`, CI's `faults` job).
 */
faultSuite(postgresFaultTarget());
