import type { MeshRequestKey, MeshRequestRecord } from "@agboss/core";

/** The mesh requests of the store's own tests (the contract suite has its own data). */

/** How long an attempt holds a running request without renewing it: the core's `MESH_REQUEST_LEASE_MS`, which no public entry exports. */
export const MESH_REQUEST_LEASE_MS = 30_000;

export const NINE = "2026-01-05T09:00:00.000Z";

export const keyOf = (idempotencyKey: string): MeshRequestKey => ({
  tenantId: "acme",
  peer: "orders-application",
  idempotencyKey,
});

const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** A request admitted at `createdAt` by `attemptId`: its lease one `MESH_REQUEST_LEASE_MS` long, its answer kept a day. */
export const requestOf = (
  idempotencyKey: string,
  createdAt = NINE,
  attemptId = "attempt-1",
): MeshRequestRecord => ({
  ...keyOf(idempotencyKey),
  tool: "charge",
  requestHash: "sha256:aaaa",
  createdAt,
  expiresAt: plus(createdAt, 24 * 60 * 60 * 1000),
  attemptId,
  lockedUntil: plus(createdAt, MESH_REQUEST_LEASE_MS),
});
