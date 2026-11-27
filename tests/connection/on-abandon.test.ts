import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { PostgresConnection } from "../../src/index.js";
import { listenerOf } from "../../src/connection/postgres-connection.js";

/**
 * The stop that abandons a connection's `onDestroy` calls its `onAbandon` (agbossjs/agboss#954,
 * the core's `OnAbandon`): no listener opens over it any more, the pool is ended and its clients
 * dropped. Built with no database: nothing connects.
 */
const URL = "postgres://u:p@localhost:1/d";

describe("PostgresConnection.onAbandon", () => {
  it("ends the pool, and a listener asked for afterwards is refused as the stop's", async () => {
    const connection = new PostgresConnection({ url: URL });

    connection.onAbandon();

    expect(connection.pool.ended).toBe(true);
    await expect(
      listenerOf(connection, {
        channel: "c",
        payload: "p",
        clock: new VirtualClock(),
        warn: () => undefined,
        onNotify: () => undefined,
      }),
    ).rejects.toThrow(/closed|stop/i);
  });

  it("is safe after onDestroy and twice (the stop calls it at most once, a test may not)", async () => {
    const connection = new PostgresConnection({ url: URL });
    await connection.onDestroy();

    expect(() => {
      connection.onAbandon();
      connection.onAbandon();
    }).not.toThrow();
  });
});
