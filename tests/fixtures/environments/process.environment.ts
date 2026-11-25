import type { EmptyEnvironment } from "@agboss/core";

/**
 * A process of tests/processes/: the application's own settings are none — the database
 * (`AGBOSS_PROCESS_DATABASE_URL`), the idempotency secret (`AGBOSS_PROCESS_IDEMPOTENCY_KEY`) and the
 * mesh peer's public key (`AGBOSS_PROCESS_MESH_PEER_KEY`) are references its storage and its mesh
 * read from the process when it starts.
 */
export const environment: EmptyEnvironment = {};
