import {
  heldStoreSeam,
  OperationPhase,
  processHoldPoints,
  StoreHoldPoint,
  withHoldPoints,
} from "@agboss/core/testing/faults";
import { PostgresExecutionLeaseRepository } from "../../src/index.js";
import { emit } from "./process-log.js";

/**
 * The lease store of the process tests (agbossjs/agboss#520 AC1, #484 AC5): the package's, with
 * the core's published store hold points — no seam of this repository's own. A test arms a hold
 * of the next `acquire` of a key (`hold-acquire`): that `acquire` stops after the framework decided
 * to ask the store and before the store is asked, says `held`, and goes on when the test lets it
 * (`let-acquire`); its answer is told as `acquire-result`. The process's own memory: nothing is
 * shared but the database.
 */
export const HeldPostgresExecutionLeaseRepository = withHoldPoints(
  PostgresExecutionLeaseRepository,
);

/** Tells the test of every held operation and every answered `acquire` of this process. */
export function reportHolds(instanceId: string): void {
  heldStoreSeam.instanceId = instanceId;
  processHoldPoints.onHeld((operation) => {
    emit("held", { ...operation });
  });
  heldStoreSeam.recorder = {
    record: (event) => {
      if (
        event.phase !== OperationPhase.Complete ||
        event.operation !== StoreHoldPoint.LeaseAcquire
      )
        return;
      const lease = event.output as { leaseEpoch?: number } | null | undefined;
      emit("acquire-result", { key: event.key, leaseEpoch: lease?.leaseEpoch ?? null });
    },
  };
}

/** The next `acquire` of `key` waits for `letAcquireGo(key)`. */
export function holdAcquireOf(key: string): void {
  processHoldPoints.arm({ point: StoreHoldPoint.LeaseAcquire, key });
}

/** Every held `acquire` of `key` goes on to the store. */
export function letAcquireGo(key: string): void {
  for (const held of processHoldPoints.held)
    if (held.point === StoreHoldPoint.LeaseAcquire.valueOf() && held.key === key)
      processHoldPoints.release(held.holdId);
}
