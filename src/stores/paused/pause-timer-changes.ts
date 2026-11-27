import { PauseStatus, type PauseRecord } from "@agboss/core";
import {
  markSentChange,
  onceNotices,
  remindChange,
  timeoutChange,
  type PauseNoticeFacts,
  type PauseNoticeKind,
  type PauseRecipients,
  type PauseTimeoutChange,
} from "@agboss/core/stores";
import type pg from "pg";
import { firstRowOf, changesOf } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { escapedJsonOf } from "../nul-escape.js";
import { appendNotices } from "./pause-notice-rows.js";
import { LOCKED_PAUSE, recordOfRow } from "./pause-rows.js";
import { missed, transitioned } from "./pause-transition.js";

/**
 * The changes of a pause that read it first (agbossjs/agboss#935, #910, #1307): the deadline changed
 * (`timeoutChange`), the reminder (`remindChange`), the channel asked (`markSentChange`) and a notice
 * of its own (`onceNotices`) — each the core's pure rule over the pause row-locked and read, so no
 * two instances write a mailbox of the pause at once, and the write is still a compare-and-set.
 */
export class PauseTimerChanges {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * The deadline changed — only while open and as the caller read it, from the deadline it read, to
   * none or to a time after `at`, within the record's cap and count (the core's rule) —, its
   * `expires_at` and `remind_at` columns NULL when there is none, with its `timeout-changed` entry
   * and notices.
   */
  changeTimeout(
    tenantId: string,
    pauseId: string,
    change: PauseTimeoutChange,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return transitioned(this.pool, { tenantId, pauseId }, (pause) =>
      timeoutChange(pause, change, at, recipients),
    );
  }

  /** The reminder of a `Pending` pause, once: `remindAt ≤ at < expiresAt`; `false` when it does not apply. */
  async remind(
    tenantId: string,
    pauseId: string,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    const reminded = await transitioned(this.pool, { tenantId, pauseId }, (pause) =>
      remindChange(pause, at, recipients),
    );
    return reminded !== undefined;
  }

  /**
   * The channel was asked (rule 2), whatever the pause's status: `isSent`, and — only when it was
   * not yet — the notices `markSentChange` plans from the pause as it was read. `true` while the
   * pause is `Pending`.
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
        const sent = markSentChange(before, recipients, externalRef);
        const changed = await changesOf(
          database,
          `UPDATE agboss_pauses SET record = $3::jsonb WHERE tenant_id = $1 AND pause_id = $2`,
          [tenantId, pauseId, escapedJsonOf(sent.pause)],
        );
        // read first under the row lock: any other count is damage, as in the core's SQLite store
        if (changed !== 1) throw new Error(missed({ tenantId, pauseId }));
        await appendNotices(database, tenantId, pauseId, sent.notices);
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
    return inPoolTransaction(this.pool, async (database) => {
      const read = await firstRowOf(database, LOCKED_PAUSE, [tenantId, pauseId]);
      if (read === undefined) return false;
      // planned (and its times checked) even when nothing is written: the refusal never depends on the data
      const planned = onceNotices(recordOfRow(read), kind, facts, at, recipients);
      return (await appendNotices(database, tenantId, pauseId, planned, kind)) > 0;
    });
  }
}
