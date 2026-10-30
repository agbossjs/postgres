import { VirtualClock } from "@agboss/core/testing";
import type { ContractTarget, StoreSeam } from "@agboss/core/testing/contracts";
import { PostgresConnection } from "../../src/index.js";
import { truncateAll, type TestDatabase } from "../support/database.js";

/**
 * The PostgreSQL stores as targets of the core's published contract suites (#481): each case on
 * an emptied schema of the test file's own, each of its two instances with a pool of its own — two
 * application instances on one database, as two pods are.
 *
 * The suites move time with their `VirtualClock`, whose `advance` lets woken work run for one
 * `setImmediate` — enough for the core's in-memory and synchronous SQLite stores, not for a round
 * trip to a database. So each store's calls are tracked, and the case's clock waits for the calls
 * in flight before and after each `advance`: what the clock documents ("the work already started
 * first reaches its next wait"), for a store whose work is I/O. Nothing of the store changes.
 */

/** What a test registers to be closed with its store (a client it holds). */
export type OnClose = (close: () => Promise<void> | void) => void;

/** How a test builds one instance's store on that instance's connection. */
export type PostgresStoreFactory<TStore> = (
  connection: PostgresConnection,
  seam: StoreSeam,
  onClose: OnClose,
) => TStore | Promise<TStore>;

/** The store calls not settled yet, of one case's instances. */
type InFlight = Set<Promise<unknown>>;

const isThenable = (value: unknown): value is Promise<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/** `target`'s methods, each call's promise kept in `inFlight` until it settles. */
function tracked<TObject extends object>(target: TObject, inFlight: InFlight): TObject {
  return new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, object, args);
        if (!isThenable(result)) return result;
        // settled either way: the case sees the rejection itself, this copy only counts it
        const call: Promise<unknown> = result.then(
          () => inFlight.delete(call),
          () => inFlight.delete(call),
        );
        inFlight.add(call);
        return result;
      };
    },
  });
}

/** Waits until no tracked call is in flight (a settled call may start the next one). */
async function drained(inFlight: InFlight): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

const patched = new WeakSet<VirtualClock>();

/** The case's clock waits for its stores' calls around every `advance`. */
function waitForCallsOn(clock: StoreSeam["clock"], inFlight: InFlight): void {
  if (!(clock instanceof VirtualClock) || patched.has(clock)) return;
  patched.add(clock);
  const advance = clock.advance.bind(clock);
  Object.defineProperty(clock, "advance", {
    value: async (...args: Parameters<VirtualClock["advance"]>): Promise<void> => {
      await drained(inFlight);
      await advance(...args);
      await drained(inFlight);
    },
  });
}

/** Tracks the calls of a store — or of each store of a group (`{ effects, leases, rows }`). */
function trackedStore<TStore extends object>(store: TStore, inFlight: InFlight): TStore {
  if (Object.getPrototypeOf(store) !== Object.prototype) return tracked(store, inFlight);
  const group: Record<string, unknown> = {};
  for (const [name, part] of Object.entries(store))
    group[name] = typeof part === "object" && part !== null ? tracked(part, inFlight) : part;
  return Object.assign(Object.create(null) as TStore, group);
}

export function postgresTarget<TStore extends object>(
  database: TestDatabase,
  make: PostgresStoreFactory<TStore>,
): ContractTarget<TStore> {
  const closers = new WeakMap<TStore, (() => Promise<void> | void)[]>();
  const inFlight: InFlight = new Set();
  return {
    name: "PostgreSQL",
    reset: async () => {
      await truncateAll(database.url());
    },
    instance: async (seam) => {
      const connection = new PostgresConnection({ url: database.url(), poolSize: 4 });
      const closes: (() => Promise<void> | void)[] = [];
      const store = trackedStore(
        await make(connection, seam, (close) => closes.push(close)),
        inFlight,
      );
      closes.push(() => connection.onDestroy());
      closers.set(store, closes);
      waitForCallsOn(seam.clock, inFlight);
      return store;
    },
    close: async (store) => {
      await drained(inFlight);
      for (const close of closers.get(store) ?? []) await close();
    },
  };
}
