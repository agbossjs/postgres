/**
 * agbossjs/postgres#129: `trackedClientOf` (agbossjs/agboss#954) — a pool's client whose drop is in
 * the set from its making (even while it connects) to its end, and which hands `pg` the stream
 * it will drop. No server: `pg` asks for the stream only when it connects, so the test asks for it.
 */
import { Duplex, PassThrough } from "node:stream";
import { Socket } from "node:net";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { trackedClientOf } from "../../src/connection/tracked-client.js";

/** A base client that keeps the config it was made with and counts its `end()`. */
class Base extends pg.Client {
  static configs: (string | pg.ClientConfig | undefined)[] = [];
  ended = 0;

  constructor(config?: string | pg.ClientConfig) {
    super(config);
    Base.configs.push(config);
  }

  override end(): Promise<void> {
    this.ended += 1;
    return Promise.resolve();
  }
}

/** What `pg` asks of the `stream` option the base was made with, when it connects. */
function streamOf(...args: unknown[]): Duplex {
  const config = Base.configs.at(-1);
  if (typeof config !== "object" || typeof config.stream !== "function")
    throw new Error("the base got no stream function");
  return (config.stream as (...call: unknown[]) => Duplex)(...args);
}

function made(config?: string | pg.ClientConfig): {
  readonly clients: Set<() => void>;
  readonly client: Base;
} {
  const clients = new Set<() => void>();
  const Tracked = trackedClientOf(clients, Base);
  return { clients, client: new Tracked(config) as Base };
}

const configOf = (config?: string | pg.ClientConfig): pg.ClientConfig => {
  made(config);
  const given = Base.configs.at(-1);
  if (typeof given !== "object") throw new Error("the base got no config object");
  return given;
};

describe("agbossjs/postgres#129: trackedClientOf", () => {
  it("makes a connection string the base's connectionString, an object's fields stay, none is {}", () => {
    expect(configOf("postgres://u@h/db").connectionString).toBe("postgres://u@h/db");
    const object = configOf({ host: "h", port: 7, connectionString: "postgres://o@h/db" });
    expect([object.host, object.port, object.connectionString]).toEqual([
      "h",
      7,
      "postgres://o@h/db",
    ]);
    expect(Object.keys(configOf(undefined))).toEqual(["stream"]);
    expect(Object.keys(configOf("postgres://u@h/db")).sort()).toEqual([
      "connectionString",
      "stream",
    ]);
  });

  it("has a socket of its own for the stream when none is given", () => {
    made("postgres://u@h/db");

    const stream = streamOf();

    expect(stream).toBeInstanceOf(Socket);
  });

  it("asks the given stream function, with the arguments pg passes, and uses what it makes", () => {
    const given = new PassThrough();
    const calls: unknown[][] = [];
    made({
      stream: (...args: unknown[]) => {
        calls.push(args);
        return given;
      },
    });

    const stream = streamOf("a", 1);

    expect(stream).toBe(given);
    // pg itself asked it once while making the client, with its parameters
    expect(calls.at(-1)).toEqual(["a", 1]);
  });

  it("is in the set from its making, and out of it when its stream closes (an SSL refusal)", () => {
    const { clients } = made("postgres://u@h/db");
    expect(clients.size).toBe(1);
    const stream = streamOf();

    stream.emit("close");

    expect(clients.size).toBe(0);
  });

  it("is out of the set at its end, and only its own drop leaves", () => {
    const clients = new Set<() => void>();
    const Tracked = trackedClientOf(clients, Base);
    const first = new Tracked("postgres://u@h/db");
    new Tracked("postgres://u@h/db");
    expect(clients.size).toBe(2);

    first.emit("end");

    expect(clients.size).toBe(1);
  });

  it("drops: ends the client and destroys the socket it made", () => {
    const { clients, client } = made("postgres://u@h/db");
    const stream = streamOf();

    for (const drop of clients) drop();

    expect(client.ended).toBe(1);
    expect(stream.destroyed).toBe(true);
  });

  it("drops a client that never connected: nothing to destroy, still ended", () => {
    const { clients, client } = made("postgres://u@h/db");

    for (const drop of clients) drop();

    expect(client.ended).toBe(1);
  });

  it("swallows the error its drop causes: no listener of the pool's, no throw", () => {
    const { client } = made("postgres://u@h/db");

    expect(() =>
      client.emit("error", new Error("Connection terminated unexpectedly")),
    ).not.toThrow();
    expect(client.listenerCount("error")).toBe(1);
  });
});
