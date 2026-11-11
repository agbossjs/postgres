import {
  A2ADirectMessageRepository,
  A2ADirectMessageState,
  Injectable,
  type A2ADirectMessageAttempt,
  type A2ADirectMessageKey,
  type A2ADirectMessageRecord,
  type A2ADirectMessageReply,
  type A2ADirectMessageSave,
  type NewA2ADirectMessage,
  type StoreDescriptor,
} from "@agboss/core";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, rowsOf } from "../connection/query.js";
import { inPoolTransaction } from "../connection/transaction.js";
import { MESSAGE_KEY, messageKeyOf } from "./a2a-tasks/a2a-task-rows.js";
import { checkedLimit, directMessageOf } from "./a2a-direct-messages/a2a-direct-message-rows.js";
import {
  directMessageAt,
  freedClaims,
  savedDirectOnce,
} from "./a2a-direct-messages/a2a-direct-message-statements.js";
import { escapedJsonOf } from "./nul-escape.js";

/** How often a save whose conflicting row vanished before it was read tries again. */
const SAVE_ATTEMPTS = 2;

/** A message as `saveIfAbsent` keeps it: `InFlight`, its first attempt. */
const savedOf = (message: NewA2ADirectMessage): A2ADirectMessageRecord => ({
  tenantId: message.tenantId,
  ownerId: message.ownerId,
  messageId: message.messageId,
  requestHash: message.requestHash,
  skill: message.skill,
  contextId: message.contextId,
  state: A2ADirectMessageState.InFlight,
  attemptId: message.attemptId,
  startedAt: message.startedAt,
  expiresAt: message.expiresAt,
  callsModel: message.callsModel,
  createdAt: message.createdAt,
  ...(message.callerPeer === undefined ? {} : { callerPeer: message.callerPeer }),
  ...(message.meshBodyHash === undefined ? {} : { meshBodyHash: message.meshBodyHash }),
});

/** The message's row while `InFlight` under the attempt: `$4` the state, `$5` the attempt. */
const IN_FLIGHT_UNDER = `${MESSAGE_KEY} AND state = $4 AND attempt_id = $5`;

/**
 * `A2ADirectMessageRepository` on PostgreSQL (agbossjs/agboss#860): the direct replies an
 * application serves, shared by every instance on the database — a message resent to any pod gets
 * the reply its first run made. A row per message in `agboss_a2a_direct_messages` (migration 0030),
 * its id claimed in the A2A task store's `agboss_a2a_messages` (a claim of no task, `task_id` `''`)
 * in the same transaction: both reply modes insert into that table's primary key, so a task message
 * and a direct message of one id are never both kept.
 *
 * - `saveIfAbsent` is one transaction at `READ COMMITTED`: the claim's
 *   `INSERT … ON CONFLICT DO NOTHING` first — of two pods accepting one message the second's insert
 *   waits for the first's claim — else the claim kept, read `FOR KEY SHARE`; then the row kept, a
 *   claim of another message (`Taken`), or the row's insert.
 * - `completeIfInFlight`, `retakeIfExpired` and `deleteIfInFlight` are one compare-and-set
 *   statement each (`WHERE state = 'in-flight' AND attempt_id = $n`, and `expires_at <= now` for a
 *   retake): of two writers exactly one changes the row; a completed reply never changes.
 * - `deleteByCreatedAtBefore` is one transaction: the oldest rows before the cutoff, then the
 *   claims left without a row, locked `FOR UPDATE` before they are deleted.
 *
 * Times are the caller's (the application's `Clock`), as parameters. Listed in
 * `@Application({ providers })` beside `PostgresA2ATaskRepository`, with `postgresUrl`.
 */
@Injectable({ deps: [PostgresConnection] })
export class PostgresA2ADirectMessageRepository extends A2ADirectMessageRepository {
  static override readonly store: StoreDescriptor = { backend: "postgres" };

  constructor(private readonly connection: PostgresConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  saveIfAbsent(message: NewA2ADirectMessage): Promise<A2ADirectMessageSave> {
    const saved = savedOf(message);
    return inPoolTransaction(this.connection.pool, async (client) => {
      for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
        const answer = await savedDirectOnce(client, message, saved);
        if (answer !== undefined) return answer;
      }
      throw new Error(
        "a direct A2A message's rows conflicted, then were gone, twice: nothing is saved",
      );
    });
  }

  findByKey(key: A2ADirectMessageKey): Promise<A2ADirectMessageRecord | undefined> {
    return directMessageAt(this.connection.pool, key);
  }

  async completeIfInFlight(
    key: A2ADirectMessageKey,
    attemptId: string,
    reply: A2ADirectMessageReply,
    completedAt: Date,
  ): Promise<A2ADirectMessageRecord | undefined> {
    const [row] = await rowsOf(
      this.connection.pool,
      `UPDATE agboss_a2a_direct_messages SET state = $6, reply = $7::jsonb, completed_at = $8
       WHERE ${IN_FLIGHT_UNDER} RETURNING *`,
      [
        ...messageKeyOf(key),
        A2ADirectMessageState.InFlight,
        attemptId,
        A2ADirectMessageState.Completed,
        escapedJsonOf(reply),
        completedAt,
      ],
    );
    return row === undefined ? undefined : directMessageOf(row);
  }

  async retakeIfExpired(
    key: A2ADirectMessageKey,
    expiredAttemptId: string,
    next: A2ADirectMessageAttempt,
    now: Date,
  ): Promise<A2ADirectMessageRecord | undefined> {
    const [row] = await rowsOf(
      this.connection.pool,
      `UPDATE agboss_a2a_direct_messages SET attempt_id = $6, started_at = $7, expires_at = $8
       WHERE ${IN_FLIGHT_UNDER} AND expires_at <= $9 RETURNING *`,
      [
        ...messageKeyOf(key),
        A2ADirectMessageState.InFlight,
        expiredAttemptId,
        next.attemptId,
        next.startedAt,
        next.expiresAt,
        now,
      ],
    );
    return row === undefined ? undefined : directMessageOf(row);
  }

  async deleteIfInFlight(key: A2ADirectMessageKey, attemptId: string): Promise<boolean> {
    const removed = await changesOf(
      this.connection.pool,
      `DELETE FROM agboss_a2a_direct_messages WHERE ${IN_FLIGHT_UNDER}`,
      [...messageKeyOf(key), A2ADirectMessageState.InFlight, attemptId],
    );
    return removed === 1;
  }

  async findAllInFlightByExpiresAtBefore(
    now: Date,
    limit: number,
  ): Promise<readonly A2ADirectMessageRecord[]> {
    const rows = await rowsOf(
      this.connection.pool,
      `SELECT * FROM agboss_a2a_direct_messages WHERE state = $1 AND expires_at <= $2
       ORDER BY expires_at, tenant_id, owner_id, message_id LIMIT $3`,
      [A2ADirectMessageState.InFlight, now, checkedLimit(limit)],
    );
    return rows.map(directMessageOf);
  }

  async deleteByCreatedAtBefore(
    cutoff: Date,
    limit: number,
  ): Promise<readonly A2ADirectMessageRecord[]> {
    const page = checkedLimit(limit);
    return inPoolTransaction(this.connection.pool, async (client) => {
      const rows = await rowsOf(
        client,
        `WITH gone AS (
           DELETE FROM agboss_a2a_direct_messages d USING (
             SELECT tenant_id, owner_id, message_id FROM agboss_a2a_direct_messages
             WHERE created_at < $1 ORDER BY created_at, tenant_id, owner_id, message_id LIMIT $2
           ) oldest
           WHERE d.tenant_id = oldest.tenant_id AND d.owner_id = oldest.owner_id
             AND d.message_id = oldest.message_id
           RETURNING d.*)
         SELECT * FROM gone ORDER BY created_at, tenant_id, owner_id, message_id`,
        [cutoff, page],
      );
      // the claims of the removed, and those whose message went before (a failed attempt's)
      await freedClaims(client, cutoff);
      return rows.map(directMessageOf);
    });
  }
}
