import {
  Injectable,
  MeshRequestRepository,
  type MeshRequestKey,
  type MeshRequestRecord,
} from "@agboss/core";
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";

const KEY = "tenant_id = $1 AND peer = $2 AND idempotency_key = $3";

/**
 * A request's row: `answered` tells an answer of JSON `null` (`'null'::jsonb`, which the driver
 * reads as `null` too) from a request that has none yet (SQL `NULL`).
 */
const Row = z.object({
  tenant_id: z.string(),
  peer: z.string(),
  idempotency_key: z.string(),
  created_at: z.date(),
  response: z.unknown(),
  answered: z.boolean(),
});

const keyOf = (key: MeshRequestKey): readonly [string, string, string] => [
  key.tenantId,
  key.peer,
  key.idempotencyKey,
];

/**
 * `MeshRequestRepository` on PostgreSQL (agbossjs/agboss#483): one row per trusted mesh request,
 * by the receiver's tenant, the peer and the caller's idempotency key, its answer as `jsonb`.
 * `saveIfAbsent` is one `INSERT … ON CONFLICT DO NOTHING`: of two instances admitting one key —
 * a request retried against another pod — exactly one inserts it and runs it, the other finds it
 * (its answer, or a run still in progress). The answer, the forget and the retention sweep's
 * `deleteCreatedBefore` (the `Clock`'s cutoff, passed as a parameter) are one statement each. Every
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
    const inserted = await changesOf(
      this.connection.pool,
      `INSERT INTO agboss_mesh_requests (tenant_id, peer, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, peer, idempotency_key) DO NOTHING`,
      [...keyOf(record), new Date(record.createdAt)],
    );
    return inserted === 1;
  }

  async findByKey(key: MeshRequestKey): Promise<MeshRequestRecord | undefined> {
    const row = await firstRowOf(
      this.connection.pool,
      `SELECT tenant_id, peer, idempotency_key, created_at, response,
         response IS NOT NULL AS answered
       FROM agboss_mesh_requests WHERE ${KEY}`,
      keyOf(key),
    );
    if (row === undefined) return undefined;
    const parsed = Row.parse(row);
    return {
      tenantId: parsed.tenant_id,
      peer: parsed.peer,
      idempotencyKey: parsed.idempotency_key,
      createdAt: parsed.created_at.toISOString(),
      ...(parsed.answered ? { response: parsed.response } : {}),
    };
  }

  async saveResponse(key: MeshRequestKey, response: unknown): Promise<void> {
    await changesOf(
      this.connection.pool,
      `UPDATE agboss_mesh_requests SET response = $4::jsonb WHERE ${KEY}`,
      [...keyOf(key), JSON.stringify(response)],
    );
  }

  async deleteByKey(key: MeshRequestKey): Promise<void> {
    await changesOf(
      this.connection.pool,
      `DELETE FROM agboss_mesh_requests WHERE ${KEY}`,
      keyOf(key),
    );
  }

  async deleteCreatedBefore(cutoff: Date): Promise<void> {
    await changesOf(
      this.connection.pool,
      "DELETE FROM agboss_mesh_requests WHERE created_at < $1",
      [cutoff],
    );
  }
}
