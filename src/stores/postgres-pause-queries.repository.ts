import type { PauseRecord } from "@agboss/core";
import type {
  PauseFilter,
  PauseNoticeClaim,
  PauseNoticeCounts,
  PausePage,
  SetAsideMailbox,
} from "@agboss/core/stores";
import type { Milliseconds } from "@agboss/core/units";
import * as mailboxes from "./paused/pause-delivery-rows.js";
import {
  assertPauseFilter,
  assertScanLimit,
  PauseScans,
  seqOfCursor,
} from "./paused/pause-scans.js";
import { PostgresPausedRunRepository } from "./postgres-paused-runs.repository.js";

/**
 * The second layer of `PostgresPausedExecutionRepository`: the scans, the retention's look and
 * delete, and the delivery of notices. A refused argument rejects the promise, never throws.
 */
export abstract class PostgresPauseQueryRepository extends PostgresPausedRunRepository {
  async findPendingByExpiresAtBefore(at: Date, limit: number): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    return new PauseScans(this.connection.pool).pendingDue("expires_at", at, limit);
  }

  async findPendingByRemindAtBefore(at: Date, limit: number): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    return new PauseScans(this.connection.pool).pendingDue("remind_at", at, limit);
  }

  async findOpenAfter(after: string | undefined, limit: number): Promise<PausePage> {
    assertScanLimit(limit);
    return new PauseScans(this.connection.pool).open(seqOfCursor(after), limit);
  }

  async findPageByTenantId(
    tenantId: string,
    filter: PauseFilter,
    limit: number,
    after?: string,
  ): Promise<PausePage> {
    assertScanLimit(limit);
    assertPauseFilter(filter);
    return new PauseScans(this.connection.pool).ofTenant(
      tenantId,
      filter,
      seqOfCursor(after),
      limit,
    );
  }

  async findClosedByResolvedAtBefore(cutoff: Date, limit: number): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    return new PauseScans(this.connection.pool).closedBefore(cutoff, limit);
  }

  deleteByResolvedAtBefore(cutoff: Date): Promise<void> {
    return new PauseScans(this.connection.pool).deleteClosedBefore(cutoff);
  }

  async claimNoticesDue(
    at: Date,
    limit: number,
    claimFor: Milliseconds,
    recipients: readonly string[],
  ): Promise<readonly PauseNoticeClaim[]> {
    assertScanLimit(limit);
    return mailboxes.claimDue(this.connection.pool, at, limit, claimFor, recipients);
  }

  ackNotice(claim: PauseNoticeClaim, at: Date): Promise<PauseNoticeClaim | undefined> {
    return mailboxes.ackHead(this.connection.pool, claim, at);
  }

  retryNotice(claim: PauseNoticeClaim, nextAttemptAt: Date, problem: string): Promise<boolean> {
    return mailboxes.retryHead(this.connection.pool, claim, nextAttemptAt, problem);
  }

  setAsideNotices(claim: PauseNoticeClaim, _at: Date, problem: string): Promise<boolean> {
    return mailboxes.setAside(this.connection.pool, claim, problem);
  }

  async setAsideStaleNoticesBefore(
    writtenBefore: Date,
    at: Date,
    problem: string,
    limit: number,
  ): Promise<readonly SetAsideMailbox[]> {
    assertScanLimit(limit);
    return mailboxes.setAsideStale(this.connection.pool, writtenBefore, at, problem, limit);
  }

  countNotices(): Promise<PauseNoticeCounts> {
    return mailboxes.countNotices(this.connection.pool);
  }
}
