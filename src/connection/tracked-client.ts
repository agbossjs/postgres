import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import pg from "pg";
import { dropClient } from "./drop-client.js";

/**
 * A client class for the pool whose socket is ours to drop (agbossjs/agboss#954): `pg`'s graceful
 * `end()` waits for a server that does not answer, and `pool.end()` for every client's `end()`.
 * `Base` is the client class it extends (the pool's timed client, agbossjs/agboss#928). Each client adds its drop to `clients` from its making (even while it connects) to its end.
 */
export function trackedClientOf(
  clients: Set<() => void>,
  Base: typeof pg.Client = pg.Client,
): typeof pg.Client {
  class TrackedClient extends Base {
    constructor(config?: string | pg.ClientConfig) {
      const given = typeof config === "string" ? { connectionString: config } : (config ?? {});
      let socket: Duplex | undefined;
      super({
        ...given,
        stream: (...args: unknown[]) => {
          const made = (
            typeof given.stream === "function"
              ? (given.stream as (...call: unknown[]) => unknown)(...args)
              : new Socket()
          ) as Duplex;
          // an SSL refusal ends the stream without the client's `end`: its close forgets it too
          made.once("close", () => {
            forget();
          });
          socket = made;
          return made;
        },
      });
      // a client checked out of the pool has no listener of the pool's: the drop's own error
      // ("Connection terminated unexpectedly") must not be the process's
      this.on("error", () => undefined);
      const drop = (): void => {
        dropClient(this, socket);
      };
      clients.add(drop);
      // `pg` asks for the stream when it connects, after this constructor ended: `forget` is set
      const forget = (): void => {
        clients.delete(drop);
      };
      this.once("end", forget);
    }
  }
  return TrackedClient;
}
