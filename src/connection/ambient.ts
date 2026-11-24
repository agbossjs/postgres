import { AsyncLocalStorage } from "node:async_hooks";
import { IdempotencyError } from "@agboss/core";
import type { PoolClient } from "pg";

/**
 * The transaction of the `runOnce` the caller is inside of (agbossjs/agboss#1317c): the effect's
 * work is handed no transaction and writes through its connection's `requireTransaction()`, so an
 * uncaught error rolls the business rows back with the result. The transaction travels with the
 * work's async context, per connection (another connection's work is never inside this one's).
 */

interface Ambient {
  readonly owner: object;
  readonly client: PoolClient;
}

const STORAGE = new AsyncLocalStorage<readonly Ambient[]>();

/** Runs `work` with `client` as `owner`'s transaction for everything it awaits. */
export function withAmbientTransaction<TResult>(
  owner: object,
  client: PoolClient,
  work: () => Promise<TResult>,
): Promise<TResult> {
  return STORAGE.run([...(STORAGE.getStore() ?? []), { owner, client }], work);
}

/** `owner`'s transaction of the `runOnce` the caller is inside of; `IdempotencyError.OutsideTransaction` outside one. */
export function requiredTransaction(owner: object): PoolClient {
  const found = STORAGE.getStore()?.findLast((each) => each.owner === owner);
  if (found !== undefined) return found.client;
  throw new IdempotencyError.OutsideTransaction({
    message:
      "requireTransaction() was called outside an Idempotency.runOnce on this connection: a repository takes the effect's transaction only inside `execute`, with a PostgreSQL fenced-effect store listed",
  });
}

/**
 * The transaction of the `runOnce` the caller is inside of, on whichever connection: for a
 * repository that holds no `PostgresConnection` of its own (and a test's business rows).
 * `IdempotencyError.OutsideTransaction` outside one.
 */
export function requirePostgresTransaction(): PoolClient {
  const found = STORAGE.getStore()?.at(-1);
  if (found !== undefined) return found.client;
  return requiredTransaction({});
}
