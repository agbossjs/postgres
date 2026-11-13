import { PauseStatus, type PauseRecord } from "@agboss/core";
import {
  PauseExpiryBound,
  PauseNoticeKind,
  type PauseExtension,
  type PauseNoticeFacts,
  type PauseRecipients,
} from "@agboss/core/stores";
import type pg from "pg";
import { z } from "zod";
import { changesOf, firstRowOf } from "../../connection/query.js";
import { inPoolTransaction } from "../../connection/transaction.js";
import { escapedJsonOf } from "../nul-escape.js";
import { whenHeard } from "./pause-changes.js";
import { markSentNotices, noticesOf } from "./pause-notice-plan.js";
import { appendNotices } from "./pause-notice-rows.js";
import { LOCKED_PAUSE, recordOfRow } from "./pause-rows.js";

/**
 * The changes of a pause that read it first (agbossjs/agboss#935, #910): the deadline moved, the
 * reminder, the channel asked and a notice of its own. Each holds the pause's row lock
 * (`SELECT … FOR UPDATE`) from its read to the end of its transaction — a closer waits, and no
 * mailbox of the pause is appended to by two at once — and the write is still a compare-and-set.
 */

const PreviousRow = z.object({ previous: z.string().nullable() });
export class PauseTimerChanges {
  constructor(private readonly pool: pg.Pool) {}

  /** The deadline moved — only while `Pending`, `expiresAt` set and after `at`, to a time after `at` (I3). */
  extend(
    tenantId: string,
    pauseId: string,
    change: PauseExtension,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return whenHeard(this.pool, recipients, async (database) => {
      const read = await firstRowOf(
        database,
        `SELECT record->>'expiresAt' AS previous FROM agboss_pauses
         WHERE tenant_id = $1 AND pause_id = $2 FOR UPDATE`,
        [tenantId, pauseId],
      );
      const previous = read === undefined ? null : PreviousRow.parse(read).previous;
      const patch = {
        expiresAt: change.expiresAt,
        expiryBound: PauseExpiryBound.Pause,
        ...(change.remindAt === undefined ? {} : { remindAt: change.remindAt }),
      };
      const row = await firstRowOf(
        database,
        `UPDATE agboss_pauses SET expires_at = $3::timestamptz, remind_at = $4::timestamptz,
           record = (record - 'remindAt') || $5::jsonb
         WHERE tenant_id = $1 AND pause_id = $2 AND status = 'pending' AND expires_at IS NOT NULL
           AND expires_at > $6 AND $3::timestamptz > $6 RETURNING record`,
        [tenantId, pauseId, change.expiresAt, change.remindAt ?? null, escapedJsonOf(patch), at],
      );
      if (row === undefined || previous === null) return undefined;
      const facts = { expiresAt: change.expiresAt, previousExpiresAt: previous };
      await appendNotices(
        database,
        tenantId,
        pauseId,
        noticesOf(recipients, PauseNoticeKind.Extended, at, facts),
      );
      return recordOfRow(row);
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
         WHERE tenant_id = $1 AND pause_id = $2 AND status = 'pending' AND expires_at IS NOT NULL
           AND expires_at > $3 AND remind_at IS NOT NULL AND remind_at <= $3 RETURNING record`,
        [tenantId, pauseId, at],
      );
      if (row === undefined) return false;
      const { expiresAt } = recordOfRow(row);
      const facts = expiresAt === undefined ? {} : { expiresAt };
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
  markSent(tenantId: string, pauseId: string, recipients: PauseRecipients): Promise<boolean> {
    return inPoolTransaction(this.pool, async (database) => {
      const read = await firstRowOf(database, LOCKED_PAUSE, [tenantId, pauseId]);
      if (read === undefined) return false;
      const before = recordOfRow(read);
      if (!before.isSent) {
        await changesOf(
          database,
          `UPDATE agboss_pauses SET record = jsonb_set(record, '{isSent}', 'true')
           WHERE tenant_id = $1 AND pause_id = $2`,
          [tenantId, pauseId],
        );
        await appendNotices(database, tenantId, pauseId, markSentNotices(before, recipients));
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
