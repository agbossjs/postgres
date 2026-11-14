import type { Duplex } from "node:stream";
import { Duplex as DuplexClass } from "node:stream";
import type pg from "pg";

/** The stream `pg` itself works over: after an SSL upgrade a TLS socket wrapping the one it was given. */
function streamOf(client: pg.Client): Duplex | undefined {
  const connection: unknown = Reflect.get(client, "connection");
  if (typeof connection !== "object" || connection === null) return undefined;
  const stream: unknown = Reflect.get(connection, "stream");
  return stream instanceof DuplexClass ? stream : undefined;
}

/**
 * Drops `client`'s connection now, without waiting for the server (agbossjs/agboss#954). `end()`
 * first: it marks the client ending and fails the statements in flight, so they reject and their
 * holders release; then the streams are destroyed — `pg`'s current one (a TLS socket after an SSL
 * upgrade wraps `socket`) and the one it was given. A client already ended has nothing left.
 */
export function dropClient(client: pg.Client, socket: Duplex | undefined): void {
  void client.end().catch(() => undefined);
  streamOf(client)?.destroy();
  socket?.destroy();
}
