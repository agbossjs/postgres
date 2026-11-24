import process from "node:process";
import type { StoreSet } from "@agboss/core/testing/contracts";

/**
 * The stores whose contracts a mutation shard needs of `store-conformance.test.ts` (agbossjs/agboss#1367); the
 * contracts of the other shards' stores take most of the run and kill none of its mutants. The file leaves them
 * out, never the vitest config (`testNamePattern`): vitest keeps a config's pattern as an override of the
 * pattern Stryker sets for each mutant's covering tests, so every mutant then ran every test of the shard.
 * The fencing shard, every run outside a mutation run and every other shard run all of them. The effects shard
 * keeps the lease and audit log stores the fencing set and the interleavings need.
 */
export const CONTRACTS_OF_SHARD: Readonly<Record<string, readonly (keyof StoreSet)[]>> = {
  "effects-and-calls": ["executionLease", "executionAuditLog", "fencedEffect", "outboundCall"],
  pauses: ["pausedExecution"],
  "a2a-direct": ["a2aDirectMessage"],
  "a2a-tasks": ["a2aTask", "a2aDirectMessage"],
  "mesh-requests": ["meshRequest"],
  "execution-records": ["executionRecord"],
  "execution-tree": ["executionTree"],
  checkpoints: ["checkpointSaver"],
  money: ["costLedger", "rateLimit", "childExecutionQueue"],
};

/** `stores` with the contracts `MUTATION_SHARD` needs, or all of them when it names no shard of the map. */
export function storesOfShard(
  stores: StoreSet,
  shard: string | undefined = process.env.MUTATION_SHARD,
): StoreSet {
  const keep = shard === undefined ? undefined : CONTRACTS_OF_SHARD[shard];
  if (keep === undefined) return stores;
  return Object.fromEntries(
    Object.entries(stores).filter(([key]) => keep.some((kept) => kept === key)),
  );
}
