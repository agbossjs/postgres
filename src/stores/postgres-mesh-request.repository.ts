import { inLongTransaction } from "../connection/transaction.js";
import {
  Injectable,
  MeshRequestRepository,
  type MeshRequestKey,
  type MeshRequestRecord,
} from "@agboss/core";
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";
import { escapedJsonOf, unescapedJson } from "./nul-escape.js";

const KEY = "tenant_id = $1 AND peer = $2 AND idempotency_key = $3";

/**
 * A request's row: `answered` tells an answer of JSON `null` (`'null'::jsonb`, which the driver
 * reads as `null` too) from a request that has none yet (SQL `NULL`).
 */
const Row = z.object({
  tenant_id: z.string(),
  peer: z.string(),
  idempotency_key: z.string(),
  tool: z.string(),
  request_hash: z.string(),
  attempt_id: z.string(),
  created_at: z.date(),
  expires_at: z.date(),
  locked_until: z.date(),
  response: z.unknown(),
  answered: z.boolean(),
});

const keyOf = (key: MeshRequestKey): readonly [string, string, string] => [
  key.tenantId,
  key.peer,
  key.idempotencyKey,
];

/**
 * `MeshRequestRepository` on PostgreSQL (agbossjs/agboss#483, #398): one row per trusted mesh
 * request, by the receiver's tenant, the peer and the caller's idempotency key — its tool, the hash
 * of its arguments, its lease (`attempt_id`, `locked_until`) and its answer as `jsonb`.
 * `saveIfAbsent` is one `INSERT … ON CONFLICT DO UPDATE … WHERE` statement: of two instances
 * admitting one key — a request retried against another pod — exactly one inserts it, or takes it
 * over when its unanswered lease lapsed (the same tool and arguments only), and runs it; the other
 * is refused. Only the attempt that holds a request renews it, answers it or forgets it: each is
 * one statement conditional on the owner token, so a stale attempt never overwrites the answer of
 * the one that took over. The retention sweep removes what expired and was answered or lapsed. Every
 * statement runs alone at `READ COMMITTED`; no other locking. Listed in
 * `@Application({ providers })` with `postgresUrl`.
 */
@Injectable({ deps: [PostgresConnection] })
export class PostgresMeshRequestRepository extends MeshRequestRepository {
  constructor(private readonly connection: PostgresConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async saveIfAbsent(record: MeshRequestRecord): Promise<boolean> {
    const saved = await changesOf(
      this.connection.pool,
      `INSERT INTO agboss_mesh_requests AS request (tenant_id, peer, idempotency_key, tool,
         request_hash, attempt_id, created_at, expires_at, locked_until, response)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (tenant_id, peer, idempotency_key) DO UPDATE SET
         attempt_id = EXCLUDED.attempt_id, created_at = EXCLUDED.created_at,
         locked_until = EXCLUDED.locked_until
       WHERE request.response IS NULL AND request.locked_until <= EXCLUDED.created_at
         AND request.tool = EXCLUDED.tool AND request.request_hash = EXCLUDED.request_hash`,
      [
        ...keyOf(record),
        record.tool,
        record.requestHash,
        record.attemptId,
        new Date(record.createdAt),
        new Date(record.expiresAt),
        new Date(record.lockedUntil),
        record.response === undefined ? null : escapedJsonOf(record.response),
      ],
    );
    return saved === 1;
  }

  async findByKey(key: MeshRequestKey): Promise<MeshRequestRecord | undefined> {
    const row = await firstRowOf(
      this.connection.pool,
      `SELECT tenant_id, peer, idempotency_key, tool, request_hash, attempt_id, created_at,
         expires_at, locked_until, response, response IS NOT NULL AS answered
       FROM agboss_mesh_requests WHERE ${KEY}`,
      keyOf(key),
    );
    if (row === undefined) return undefined;
    const parsed = Row.parse(row);
    return {
      tenantId: parsed.tenant_id,
      peer: parsed.peer,
      idempotencyKey: parsed.idempotency_key,
      tool: parsed.tool,
      requestHash: parsed.request_hash,
      attemptId: parsed.attempt_id,
      createdAt: parsed.created_at.toISOString(),
      expiresAt: parsed.expires_at.toISOString(),
      lockedUntil: parsed.locked_until.toISOString(),
      ...(parsed.answered ? { response: unescapedJson(parsed.response) } : {}),
    };
  }

  async renewLease(key: MeshRequestKey, attemptId: string, lockedUntil: string): Promise<boolean> {
    const renewed = await changesOf(
      this.connection.pool,
      `UPDATE agboss_mesh_requests SET locked_until = $5
       WHERE ${KEY} AND attempt_id = $4 AND response IS NULL`,
      [...keyOf(key), attemptId, new Date(lockedUntil)],
    );
    return renewed === 1;
  }

  async saveResponse(key: MeshRequestKey, attemptId: string, response: unknown): Promise<boolean> {
    const saved = await changesOf(
      this.connection.pool,
      `UPDATE agboss_mesh_requests SET response = $5::jsonb
       WHERE ${KEY} AND attempt_id = $4 AND response IS NULL`,
      [...keyOf(key), attemptId, escapedJsonOf(response)],
    );
    return saved === 1;
  }

  async deleteByKey(key: MeshRequestKey, attemptId: string): Promise<boolean> {
    const deleted = await changesOf(
      this.connection.pool,
      `DELETE FROM agboss_mesh_requests WHERE ${KEY} AND attempt_id = $4`,
      [...keyOf(key), attemptId],
    );
    return deleted === 1;
  }

  /** Removes every request that expired at or before `now` and is answered or whose lease lapsed; how many went. */
  deleteExpired(now: Date): Promise<number> {
    return inLongTransaction(this.connection.pool, (client) =>
      changesOf(
        client,
        `DELETE FROM agboss_mesh_requests
         WHERE expires_at <= $1 AND (response IS NOT NULL OR locked_until <= $1)`,
        [now],
      ),
    );
  }
}
