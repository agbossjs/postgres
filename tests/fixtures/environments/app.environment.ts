import type { Secret } from "@agboss/core";

/** The process application's environment contract: the PostgreSQL stores' fields, the mesh key. */
export class ProcessEnvironment {
  postgresUrl!: Secret;
  postgresPoolSize?: number;
  /** The public key of the mesh peer `orders-application` (AC4: its signed envelopes). */
  meshPeerKey!: string;
}
