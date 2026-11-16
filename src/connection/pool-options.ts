import type pg from "pg";
import { connectTimeoutOf } from "./connect-timeout.js";
import {
  checkedSchemaOf,
  checkedTimeoutOf,
  DEFAULT_COMMAND_TIMEOUT,
  DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT,
  DEFAULT_POOL_SIZE,
  searchPathOptionOf,
  type PostgresConnectionSettings,
} from "./settings.js";
import { CLIENT_TIMEOUT_MARGIN, TimedClient, type TimedClientConfig } from "./timed-client.js";

/**
 * The options of the instance's pool (agbossjs/agboss#928): every connection is a `TimedClient`
 * that reads a command timeout as `StoreCallTimeoutError` and a lost answer as
 * `StoreOutcomeUnknownError` (`outcome.ts`); the server cancels a statement past the command
 * timeout (`statement_timeout`, lock waits included), the client gives up on a silent server a
 * second later (`query_timeout`), and a session idle in a transaction is ended
 * (`idle_in_transaction_session_timeout`) so a frozen holder's row locks are freed. Settings out of
 * range fail with `PostgresSettingsError`.
 */
export function poolOptionsOf(
  settings: PostgresConnectionSettings,
): pg.PoolConfig & TimedClientConfig {
  const schema = checkedSchemaOf(settings.schema);
  const commandTimeout =
    checkedTimeoutOf("commandTimeout", settings.commandTimeout) ?? DEFAULT_COMMAND_TIMEOUT;
  const idleTimeout =
    checkedTimeoutOf("idleInTransactionTimeout", settings.idleInTransactionTimeout) ??
    DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT;
  return {
    Client: TimedClient,
    commandTimeout,
    statement_timeout: commandTimeout,
    query_timeout: commandTimeout + CLIENT_TIMEOUT_MARGIN,
    idle_in_transaction_session_timeout: idleTimeout,
    keepAlive: true,
    connectionString: settings.url,
    max: settings.poolSize ?? DEFAULT_POOL_SIZE,
    // agbossjs/agboss#989: a connection that never answers rejects the call, never hangs it
    connectionTimeoutMillis: connectTimeoutOf(settings.url),
    ...(schema === undefined ? {} : { options: searchPathOptionOf(schema) }),
  };
}
