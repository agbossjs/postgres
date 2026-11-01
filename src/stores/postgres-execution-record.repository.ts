import {
  ApplicationContext,
  Clock,
  DuplicateThreadIdError,
  ExecutionRecordRepository,
  ExecutionRecordStatus,
  IdGenerator,
  idGeneratorNameOf,
  Injectable,
} from "@agboss/core";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { pauseAnswerOfJson } from "./framework-json.js";
import * as memory from "./records/record-memory.js";
import * as reads from "./records/record-reads.js";
import type * as rows from "./records/record-rows.js";
import * as scores from "./records/record-scores.js";
import * as writes from "./records/record-writes.js";

/** How many minted ids a new thread tries before it gives up (agbossjs/agboss#550). */
const MINTED_THREAD_TRIES = 100;

/**
 * `ExecutionRecordRepository` on PostgreSQL (#265 S30, #482): threads with their owners, one
 * record per execution in the order appended (`seq`), scores, memory summaries, config snapshots
 * and the permanent log of resolved pauses — so recovery on any instance finds the roots a dead
 * one left `running`, and `--thread` reads earlier turns. Every write is one statement; the status
 * write that must not land late is a compare-and-set (`completeIfStatus`: `UPDATE … WHERE status =
 * $expected`). Times are the `Clock`'s, a new thread's id the `IdGenerator`'s (#313). Listed in
 * `@Application({ providers })` with `postgresUrl`; subclassed through public tokens only:
 * `deps: [PostgresConnection, Clock, ApplicationContext, IdGenerator]`.
 */
@Injectable({ deps: [PostgresConnection, Clock, ApplicationContext, IdGenerator] })
export class PostgresExecutionRecordRepository extends ExecutionRecordRepository {
  constructor(
    private readonly connection: PostgresConnection,
    private readonly clock: Clock,
    applicationContext: ApplicationContext,
    private readonly idGenerator: IdGenerator,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  /**
   * A new thread (agbossjs/agboss#550): a caller's own id is kept as it is (the first one keeps it);
   * a minted one the tenant has already — an `IdGenerator` that repeats its ids — is never handed
   * out: the next one is minted, at most `MINTED_THREAD_TRIES` times, then `DuplicateThreadIdError`
   * (agbossjs/agboss#613).
   */
  async createThread(thread: rows.NewThreadRecord): Promise<string> {
    if (thread.threadId !== undefined) {
      await writes.createThread(this.connection.pool, thread, thread.threadId, this.clock.now());
      return thread.threadId;
    }
    for (let tries = 0; tries < MINTED_THREAD_TRIES; tries += 1) {
      const id = this.idGenerator.newThreadId();
      if (await writes.createThread(this.connection.pool, thread, id, this.clock.now())) return id;
    }
    // agbossjs/agboss#613: the core's typed refusal, naming the project's generator class
    throw new DuplicateThreadIdError(idGeneratorNameOf(this.idGenerator), MINTED_THREAD_TRIES);
  }
  async hasThread(workflow: string, tenantId: string, threadId: string): Promise<boolean> {
    return (await this.threadOwner(workflow, tenantId, threadId)) !== undefined;
  }
  threadOwner(
    workflow: string,
    tenantId: string,
    threadId: string,
  ): Promise<{ readonly owner: string | undefined } | undefined> {
    return writes.threadOwnerOf(this.connection.pool, workflow, tenantId, threadId);
  }
  append(record: rows.NewRecord): Promise<rows.StoredRecord> {
    return writes.appendRecord(this.connection.pool, record, this.clock.now());
  }
  async complete(id: string, outcome: rows.RecordOutcome): Promise<void> {
    await writes.completeRecord(this.connection.pool, id, outcome);
  }
  completeIfStatus(
    id: string,
    expected: ExecutionRecordStatus,
    outcome: rows.RecordOutcome,
  ): Promise<boolean> {
    return writes.completeRecord(this.connection.pool, id, outcome, expected);
  }
  lastTerns(tenantId: string, threadId: string, limit: number): Promise<rows.StoredRecord[]> {
    return reads.lastRecordsOf(this.connection.pool, tenantId, threadId, limit);
  }
  byIds(ids: readonly string[]): Promise<rows.StoredRecord[]> {
    return reads.recordsByIds(this.connection.pool, ids);
  }
  findByStatus(
    status: ExecutionRecordStatus,
    limit: number,
    after?: string,
  ): Promise<rows.StoredRecord[]> {
    return reads.recordsByStatus(this.connection.pool, status, limit, after);
  }
  byVersion(workflow: string, promptVersion: string, limit: number): Promise<rows.StoredRecord[]> {
    return reads.recordsByVersion(this.connection.pool, workflow, promptVersion, limit);
  }
  unscored(
    workflow: string,
    promptVersion: string | undefined,
    limit: number,
  ): Promise<rows.StoredRecord[]> {
    return reads.unscoredRecords(this.connection.pool, workflow, promptVersion, limit);
  }
  saveScore(recordId: string, judge: string, score: number): Promise<void> {
    return scores.saveScore(this.connection.pool, recordId, judge, score, this.clock.now());
  }
  meanScore(recordIds: readonly string[]): Promise<number | null> {
    return scores.meanScoreOf(this.connection.pool, recordIds);
  }
  summary(workflow: string): Promise<rows.StoredVersionScore[]> {
    return scores.versionScoresOf(this.connection.pool, workflow);
  }
  rememberConfig(
    workflow: string,
    version: string,
    hash: string,
    snapshot: string,
  ): Promise<{ readonly drift: boolean }> {
    const now = this.clock.now();
    return scores.rememberConfig(this.connection.pool, workflow, version, hash, snapshot, now);
  }
  configSnapshots(workflow: string, version: string): Promise<rows.StoredConfigSnapshot[]> {
    return scores.configSnapshotsOf(this.connection.pool, workflow, version);
  }
  recentOriginals(workflow: string, limit: number): Promise<rows.StoredRecord[]> {
    return reads.recentOriginalRecords(this.connection.pool, workflow, limit);
  }
  uncovered(tenantId: string, threadId: string, compaction: string): Promise<rows.StoredRecord[]> {
    return memory.uncoveredRecords(this.connection.pool, tenantId, threadId, compaction);
  }
  before(
    tenantId: string,
    threadId: string,
    ternId: string,
    limit: number,
  ): Promise<rows.StoredRecord[]> {
    return memory.recordsBefore(this.connection.pool, tenantId, threadId, ternId, limit);
  }
  turnNumber(tenantId: string, threadId: string, ternId: string): Promise<number> {
    return memory.turnNumberOf(this.connection.pool, tenantId, threadId, ternId);
  }
  addSummary(summary: rows.NewSummaryRecord): Promise<rows.StoredSummary> {
    return memory.addSummary(this.connection.pool, summary, this.clock.now());
  }
  latestSummaries(
    tenantId: string,
    threadId: string,
    compaction: string,
    limit: number,
  ): Promise<rows.StoredSummary[]> {
    return memory.latestSummariesOf(this.connection.pool, tenantId, threadId, compaction, limit);
  }
  summaryCount(tenantId: string, threadId: string, compaction: string): Promise<number> {
    return memory.summaryCountOf(this.connection.pool, tenantId, threadId, compaction);
  }
  savePauseAnswer(
    tenantId: string,
    rootExecutionId: string,
    answer: rows.PauseAnswer,
  ): Promise<void> {
    return writes.savePauseAnswer(this.connection.pool, tenantId, rootExecutionId, answer);
  }
  async findPauseAnswersByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<rows.PauseAnswer[]> {
    const texts = await writes.pauseAnswerTextsOf(this.connection.pool, tenantId, rootExecutionId);
    return texts.map(pauseAnswerOfJson);
  }
}
