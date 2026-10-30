import type { ContractTarget, StoreSeam } from "@agboss/core/testing/contracts";
import { PostgresConnection } from "../../src/index.js";
import { truncateAll, type TestDatabase } from "../support/database.js";

/**
 * The PostgreSQL stores as targets of the core's published contract suites (#481): each case on
 * an emptied schema of the test file's own, each of its two instances with a pool of its own — two
 * application instances on one database, as two pods are. The suites track every store call on the
 * case's `VirtualClock`, so `advance` lets a round trip to the database finish
 * (agbossjs/agboss#511): nothing here waits for the store's calls.
 */

/** What a test registers to be closed with its store (a client it holds). */
export type OnClose = (close: () => Promise<void> | void) => void;

/** How a test builds one instance's store on that instance's connection. */
export type PostgresStoreFactory<TStore> = (
  connection: PostgresConnection,
  seam: StoreSeam,
  onClose: OnClose,
) => TStore | Promise<TStore>;

export function postgresTarget<TStore extends object>(
  database: TestDatabase,
  make: PostgresStoreFactory<TStore>,
): ContractTarget<TStore> {
  const closers = new WeakMap<TStore, (() => Promise<void> | void)[]>();
  return {
    name: "PostgreSQL",
    reset: async () => {
      await truncateAll(database.url());
    },
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
