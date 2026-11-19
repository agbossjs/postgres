/**
 * agbossjs/postgres#127: `dropClient` (agbossjs/agboss#954) ends the client and destroys both
 * streams — the one `pg` works over (a TLS socket after an SSL upgrade) and the one it was given —
 * and leaves a client with no stream, or a stream that is no duplex, alone.
 */
import type pg from "pg";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { dropClient } from "../../src/connection/drop-client.js";

/** A `pg.Client` of which only `end()` and the `connection` field `dropClient` reads exist. */
function clientOf(
  connection: unknown,
  end: () => Promise<void> = () => Promise.resolve(),
): { readonly client: pg.Client; readonly ended: () => number } {
  let ended = 0;
  const fake = {
    connection,
    end: () => {
      ended += 1;
      return end();
    },
  };
  // the fake carries the two members the function reads: the one cast of this file
  return {
    client: Object.assign(Object.create(null) as object, fake) as pg.Client,
    ended: () => ended,
  };
}

const duplex = (): Duplex => new PassThrough();

describe("agbossjs/postgres#127: dropClient", () => {
  it("ends the client and destroys pg's stream and the given socket", () => {
    const stream = duplex();
    const socket = duplex();
    const { client, ended } = clientOf({ stream });

    dropClient(client, socket);

    expect(ended()).toBe(1);
    expect(stream.destroyed).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it("an end that rejects is swallowed, and the streams are destroyed all the same", async () => {
    const stream = duplex();
    const { client } = clientOf({ stream }, () => Promise.reject(new Error("already ended")));

    expect(() => {
      dropClient(client, undefined);
    }).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(stream.destroyed).toBe(true);
  });

  it("no given socket: pg's stream is destroyed alone", () => {
    const stream = duplex();
    const { client } = clientOf({ stream });

    dropClient(client, undefined);

    expect(stream.destroyed).toBe(true);
  });

  it.each([
    ["no connection", undefined],
    ["a connection that is null", null],
    ["a connection that is a string", "connection"],
    ["a connection with no stream", {}],
    ["a stream that is no duplex", { stream: { destroy: () => Promise.reject(new Error("no")) } }],
  ])("%s: only the given socket is destroyed", (_name, connection) => {
    const socket = duplex();
    const { client, ended } = clientOf(connection);

    expect(() => {
      dropClient(client, socket);
    }).not.toThrow();

    expect(ended()).toBe(1);
    expect(socket.destroyed).toBe(true);
  });

  it("a stream that is no duplex is not destroyed", () => {
    let destroyed = false;
    const { client } = clientOf({
      stream: {
        destroy: () => {
          destroyed = true;
        },
      },
    });

    dropClient(client, undefined);

    expect(destroyed).toBe(false);
  });

  it("an object that is a connection with a duplex stream is read through `connection` and `stream` exactly", () => {
    const stream = duplex();
    const other = duplex();
    const { client } = clientOf({ stream, socket: other, _stream: other });

    dropClient(client, undefined);

    expect(stream.destroyed).toBe(true);
    expect(other.destroyed).toBe(false);
  });
});
