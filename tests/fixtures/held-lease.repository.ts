import { ApplicationContext, Injectable, StoreClock, type ExecutionLease } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { PostgresConnection, PostgresExecutionLeaseRepository } from "../../src/index.js";
import { emit } from "./process-log.js";

/** The keys whose next `acquire` waits, and the acquires waiting now (the test lets each go). */
const holds = new Set<string>();
const waiting = new Map<string, () => void>();

/** The next `acquire` of `key` waits for `letAcquireGo(key)`. */
export function holdAcquireOf(key: string): void {
  holds.add(key);
}

/** The held `acquire` of `key` goes on to the store. */
export function letAcquireGo(key: string): void {
  waiting.get(key)?.();
  waiting.delete(key);
}

/**
 * The lease store of the process tests: `PostgresExecutionLeaseRepository` as it is, with one
 * seam (agbossjs/agboss#520 AC1) — an `acquire` of a key the test named (`holdAcquireOf`) stops
 * after the framework decided to ask the store and before the store is asked: it says
 * `acquire-held`, waits until the test lets it go (`letAcquireGo`), then asks PostgreSQL and says
 * what it got (`acquire-result`). The process's own memory, as its gate: nothing is shared but the
 * database.
 */
@Injectable({ deps: [PostgresConnection, StoreClock, ApplicationContext] })
export class HeldPostgresExecutionLeaseRepository extends PostgresExecutionLeaseRepository {
  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    if (!holds.delete(rootExecutionId)) return super.acquire(tenantId, rootExecutionId, lease);
    await new Promise<void>((resolve) => {
      waiting.set(rootExecutionId, resolve);
      emit("acquire-held", { key: rootExecutionId });
    });
    const taken = await super.acquire(tenantId, rootExecutionId, lease);
    emit("acquire-result", { key: rootExecutionId, leaseEpoch: taken?.leaseEpoch ?? null });
    return taken;
  }
}
