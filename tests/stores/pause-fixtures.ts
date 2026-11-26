import { PauseKind, PauseStatus, type PauseRecord } from "@agboss/core";
import {
  PauseExpiryBound,
  PauseRespondent,
  seenOf,
  type PauseRecipients,
  type PauseSeen,
} from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { PostgresPausedExecutionRepository } from "../../src/index.js";
import { connectionTo } from "../support/stores.js";

/** The pauses and receivers of the pause store's own tests (the contract suite has its own data). */
export const DEADLINE = new Date("2026-01-05T10:00:00.000Z");
export const NINE = new Date("2026-01-05T09:00:00.000Z");
export const MID = new Date("2026-01-05T09:45:00.000Z");
export const LATER = new Date("2026-01-06T09:00:00.000Z");
export const APPROVED = { decision: { approved: true }, actor: { id: "manager-17" } };

export const pauseOf = (pauseId: string, stepKey = `run-1:${pauseId}`): PauseRecord => ({
  pauseId,
  tenantId: "default",
  threadId: "thread-1",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "order-workflow",
  stepKey,
  nodeId: "clerk-agent",
  visitNumber: 1,
  itemIndex: undefined,
  copyNumber: 1,
  kind: PauseKind.Approval,
  step: "clerk-agent",
  target: "refund-tool-approval",
  channel: "refund-approval-channel",
  respondent: PauseRespondent.Delegate,
  input: { text: "10 USD" },
  toolCall: { callId: "call-1", tool: "charge", summary: "charge" },
  trail: [
    {
      action: "opened",
      at: "2026-01-05T09:00:00.000Z",
      target: "refund-tool-approval",
      channel: "refund-approval-channel",
    },
  ],
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: "2026-01-05T09:00:00.000Z",
  // the limits the pause was opened under (#1307, Q-D): none; a record without them is not read
  firstAskedAt: "2026-01-05T09:00:00.000Z",
  escalationLimits: {},
});

/** A pause with a deadline at `DEADLINE` and a reminder half an hour before it. */
export const expiringPauseOf = (pauseId: string): PauseRecord => ({
  ...pauseOf(pauseId),
  expiresAt: DEADLINE.toISOString(),
  expiryBound: PauseExpiryBound.Pause,
  remindAt: "2026-01-05T09:30:00.000Z",
});

/** The pause's channel and two listeners. */
export const RECIPIENTS: PauseRecipients = {
  channel: "refund-approval-channel",
  listeners: ["audit-listener", "slack-listener"],
};

/** A store on a connection of its own to `url`: two of them are two application instances. */
export const instanceOn = (url: string, poolSize = 2): PostgresPausedExecutionRepository =>
  new PostgresPausedExecutionRepository(connectionTo(url, poolSize), new VirtualClock());

/**
 * The pause as `store` holds it now, as a change is planned against it: the core's `seenOf` (trail
 * length, assignees, deadline, `isSent`) of the record read. A change applies only while the pause is
 * still that (#1307).
 */
export async function seenNowOf(
  store: PostgresPausedExecutionRepository,
  tenantId: string,
  pauseId: string,
): Promise<PauseSeen> {
  const pause = await store.findByTenantIdAndPauseId(tenantId, pauseId);
  if (pause === undefined) throw new Error(`the pause ${pauseId} of ${tenantId} is not there`);
  return seenOf(pause);
}
