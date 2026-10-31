import type { ConformanceStore, StoreSeam } from "@agboss/core/testing/contracts";
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
  seam: StoreSeam,
  onClose: OnClose,
) => TStore | Promise<TStore>;

export function postgresStore<TStore extends object>(
  database: TestDatabase,
  make: PostgresStoreFactory<TStore>,
): ConformanceStore<TStore> {
  const closers = new WeakMap<TStore, (() => Promise<void> | void)[]>();
  return {
    instance: async (seam) => {
      const connection = new PostgresConnection({ url: database.url(), poolSize: 4 });
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
