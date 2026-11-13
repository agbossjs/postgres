import {
  Clock,
  Injectable,
  type PauseAnswer,
  type PauseCancellation,
  type PauseRecord,
} from "@agboss/core";
import type {
  PauseExpiry,
  PauseExtension,
  PauseNoticeFacts,
  PauseNoticeKind,
  PauseRecipients,
  PauseUntakenResolution,
} from "@agboss/core/stores";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { PauseChanges } from "./paused/pause-changes.js";
import { PauseTimerChanges } from "./paused/pause-timer-changes.js";
import { PostgresPauseQueryRepository } from "./postgres-pause-queries.repository.js";

/**
 * `PausedExecutionRepository` on PostgreSQL, contract v2 (#265, #267 S35, #482, agbossjs/agboss#936):
 * one row per thread of a tenant — the paused run and the versions it paused under — one row per
 * pause, the record as `jsonb` with its status, resolution time, deadline, reminder and channel as
 * columns, and one row per pause and receiver for its notices. Every transition of a pending pause
 * is one compare-and-set `UPDATE … WHERE status = 'pending' [AND <deadline>] RETURNING` — of two
 * resumes on two instances exactly one records its decision, and none at or after the deadline —
 * in one `READ COMMITTED` transaction with the notices it writes: a notice is never without its
 * change nor a change without its notice. Delivery claims a mailbox with `FOR UPDATE SKIP LOCKED`,
 * so two instances never claim one. With `PostgresCheckpointSaver` a pause made on one instance is
 * resumed on any. Listed in `@Application({ providers })` with `postgresUrl`.
 */
@Injectable({ deps: [PostgresConnection, Clock] })
export class PostgresPausedExecutionRepository extends PostgresPauseQueryRepository {
  markSentByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    return new PauseTimerChanges(this.connection.pool).markSent(tenantId, pauseId, recipients);
  }

  resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return new PauseChanges(this.connection.pool).resolve(
      tenantId,
      pauseId,
      answer,
      at,
      recipients,
    );
  }

  decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<boolean> {
    return new PauseChanges(this.connection.pool).decide(tenantId, pauseId, answer, at);
  }

  cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return new PauseChanges(this.connection.pool).cancel(
      tenantId,
      pauseId,
      resolution,
      at,
      recipients,
    );
  }

  expireByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    expiry: PauseExpiry,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return new PauseChanges(this.connection.pool).expire(tenantId, pauseId, expiry, at, recipients);
  }

  closeUntakenByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseUntakenResolution,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return new PauseChanges(this.connection.pool).closeUntaken(
      tenantId,
      pauseId,
      resolution,
      at,
      recipients,
    );
  }

  extendByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    change: PauseExtension,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return new PauseTimerChanges(this.connection.pool).extend(
      tenantId,
      pauseId,
      change,
      at,
      recipients,
    );
  }

  remindByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    return new PauseTimerChanges(this.connection.pool).remind(tenantId, pauseId, at, recipients);
  }

  noticeOnceByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    kind: PauseNoticeKind,
    facts: PauseNoticeFacts,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    return new PauseTimerChanges(this.connection.pool).noticeOnce(
      tenantId,
      pauseId,
      kind,
      facts,
      at,
      recipients,
    );
  }
}
