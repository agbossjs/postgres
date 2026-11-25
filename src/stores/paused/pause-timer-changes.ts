import { PauseStatus, type PauseRecord } from "@agboss/core";
import {
  PauseNoticeKind,
  type PauseDeadlineChange,
  type PauseNoticeFacts,
  type PauseRecipients,
} from "@agboss/core/stores";
import type pg from "pg";
import { changesOf, firstRowOf } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { escapedJsonOf } from "../nul-escape.js";
import { whenHeard } from "./pause-changes.js";
import { markSentNotices, noticesOf } from "./pause-notice-plan.js";
import { appendNotices } from "./pause-notice-rows.js";
import { writtenPause } from "./pause-reassign.js";
import { LOCKED_PAUSE, recordOfRow } from "./pause-rows.js";
import { extendPlan, sentPause } from "./pause-timer-plan.js";

/**
 * The changes of a pause that read it first (agbossjs/agboss#935, #910): the deadline moved, the
 * reminder, the channel asked and a notice of its own. Each holds the pause's row lock
 * (`SELECT … FOR UPDATE`) from its read to the end of its transaction — a closer waits, and no
 * mailbox of the pause is appended to by two at once — and the write is still a compare-and-set.
 */

/**
 * A reminder is of a pending pause only: a resolved or cancelled one keeps its `remind_at` column,
 * and must not fire it. A constant of its own, so the mutation shard drops it
 * (agbossjs/agboss#1302).
 */
const PENDING = "AND status = 'pending'";

export class PauseTimerChanges {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * The deadline moved — the pause row-locked and read, the change planned (`extendPlan`: only while
   * `Pending`, from the deadline the caller read, to a later one, under `maxExtensions`), written
   * over the status it was read at, with its `timeout-changed` entry and its `extended` notices.
   */
  extend(
    tenantId: string,
    pauseId: string,
    change: PauseDeadlineChange,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return inPoolTransaction(this.pool, async (database) => {
      const read = await firstRowOf(database, LOCKED_PAUSE, [tenantId, pauseId]);
      if (read === undefined) return undefined;
      const before = recordOfRow(read);
      const plan = extendPlan(before, change, at, recipients);
      if (plan === undefined) return undefined;
      const written = await writtenPause(database, before, plan.pause);
      if (written === undefined) return undefined;
      await appendNotices(database, tenantId, pauseId, plan.notices);
      return written;
    });
  }

  /** The reminder of a `Pending` pause, once: `remindAt ≤ at < expiresAt`; `false` when it does not apply. */
  async remind(
    tenantId: string,
    pauseId: string,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    return whenHeard(this.pool, recipients, async (database) => {
      const row = await firstRowOf(
        database,
        `UPDATE agboss_pauses SET remind_at = NULL, record = record - 'remindAt'
         WHERE tenant_id = $1 AND pause_id = $2 AND expires_at > $3 AND remind_at <= $3
           ${PENDING} RETURNING record`,
        [tenantId, pauseId, at],
      );
      if (row === undefined) return false;
      // the statement matched `expires_at > at`: the record has its deadline
      const { expiresAt } = recordOfRow(row);
      const facts = { expiresAt };
      await appendNotices(
        database,
        tenantId,
        pauseId,
        noticesOf(recipients, PauseNoticeKind.Expiring, at, facts),
      );
      return true;
    });
  }

  /**
   * The channel was asked (rule 2), whatever the pause's status: `isSent`, and — only when it was
   * not yet — the notices `markSentNotices` plans from the pause as it was read. `true` while
   * the pause is `Pending`.
   */
  markSent(
    tenantId: string,
    pauseId: string,
    recipients: PauseRecipients,
    externalRef?: string,
  ): Promise<boolean> {
    return inPoolTransaction(this.pool, async (database) => {
      const read = await firstRowOf(database, LOCKED_PAUSE, [tenantId, pauseId]);
      if (read === undefined) return false;
      const before = recordOfRow(read);
      if (!before.isSent) {
        const sent = sentPause(before, externalRef);
        await changesOf(
          database,
          `UPDATE agboss_pauses SET record = $3::jsonb WHERE tenant_id = $1 AND pause_id = $2`,
          [tenantId, pauseId, escapedJsonOf(sent)],
        );
        await appendNotices(database, tenantId, pauseId, markSentNotices(before, sent, recipients));
      }
      return before.status === PauseStatus.Pending;
    });
  }

  /**
   * A notice of `kind` for a pause in any status, once, and only when the pause `isSent`: nothing
   * is written when any mailbox of the pause has a notice of that kind. Whether it wrote.
   */
  noticeOnce(
    tenantId: string,
    pauseId: string,
    kind: PauseNoticeKind,
    facts: PauseNoticeFacts,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    return whenHeard(this.pool, recipients, async (database) => {
      const read = await firstRowOf(database, LOCKED_PAUSE, [tenantId, pauseId]);
      if (read === undefined || !recordOfRow(read).isSent) return false;
      const planned = noticesOf(recipients, kind, at, facts);
      return (await appendNotices(database, tenantId, pauseId, planned, kind)) > 0;
    });
  }
}
