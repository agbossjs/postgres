import type { Secret } from "@agboss/core";

// every process of a test keys its business-key fingerprints alike (agbossjs/agboss#825): a fixed test key
process.env.AGBOSS_PROCESS_IDEMPOTENCY_KEY ??= "postgres-process-idempotency-key";

/** The process application's environment contract: the PostgreSQL stores' fields, the mesh key. */
export class ProcessEnvironment {
  postgresUrl!: Secret;
  postgresPoolSize?: number;
  /** The public key of the mesh peer `orders-application` (AC4: its signed envelopes). */
  meshPeerKey!: string;
  /** The idempotency key (agbossjs/agboss#825): what business-key fingerprints are keyed by. */
  idempotencyKey!: Secret;
}
