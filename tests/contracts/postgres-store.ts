import type { ContractTarget, StoreInstanceContext } from "@agboss/core/testing/contracts";
import { PostgresConnection } from "../../src/index.js";
import type { TestDatabase } from "../support/database.js";

/**
 * A PostgreSQL store as one entry of `storeConformance` (agbossjs/agboss#526): each instance on a
 * pool of its own — two application instances on one database, as two pods are. The set's
 * `reset` empties the schema before each case. The suites track every store call on the case's
 * `VirtualClock`, so `advance` lets a round trip to the database finish (agbossjs/agboss#511):
 * nothing here waits for the store's calls.
 */

/** What a test registers to be closed with its store (a client it holds). */
export type OnClose = (close: () => Promise<void> | void) => void;

/** How a test builds one instance's store on that instance's connection. */
export type PostgresStoreFactory<TStore> = (
  connection: PostgresConnection,
  seam: StoreInstanceContext,
  onClose: OnClose,
) => TStore | Promise<TStore>;

/**
 * The test-only seam of the session-zone run (`npm run test:tz:session`, agbossjs/agboss#1307 step 8):
 * with `AGBOSS_TEST_KEEP_SESSION_TZ=1` the pool's awaited `onConnect` (the package's `SET TIME ZONE
 * 'UTC'`) is taken off, so the contract runs in whatever zone the server gives the session
 * (`ALTER DATABASE … SET timezone = '+02'`) — the zone a pooler in transaction mode can leave a
 * session in. pg-pool reads `options.onConnect` at every new connection; nothing of `src/` reads
 * the environment.
 */
function keepServerSessionZone(connection: PostgresConnection): void {
  if (process.env.AGBOSS_TEST_KEEP_SESSION_TZ !== "1") return;
  const options: unknown = Reflect.get(connection.pool, "options");
  if (typeof options === "object" && options !== null) Reflect.set(options, "onConnect", undefined);
}

export function postgresStore<TStore extends object>(
  database: TestDatabase,
  make: PostgresStoreFactory<TStore>,
): Omit<ContractTarget<TStore>, "name"> {
  const closers = new WeakMap<TStore, (() => Promise<void> | void)[]>();
  return {
    instance: async (seam) => {
      const connection = new PostgresConnection({ url: database.url(), poolSize: 4 });
      keepServerSessionZone(connection);
      const closes: (() => Promise<void> | void)[] = [];
      const store = await make(connection, seam, (close) => closes.push(close));
      closes.push(() => connection.onDestroy());
      closers.set(store, closes);
      return store;
    },
    close: async (store) => {
      for (const close of closers.get(store) ?? []) await close();
    },
  };
}
