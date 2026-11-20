/**
 * agbossjs/postgres#127: the child queue's LISTEN (`PostgresListener`, agbossjs/agboss#777, #789,
 * #954, #1129) on its own, against a real server and a clock that records every sleep: what it
 * passes on, what it says when its connection fails or ends, the pauses of its reconnects, how it
 * stops (`close()` never waits long on a silent server, `destroy()` drops a connection at once,
 * even one still starting) and that no timer outlives the step it bounds.
 */
import { seconds } from "@agboss/core/units";
import { Socket } from "node:net";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresListener, type PostgresListenerOptions } from "../../src/connection/listener.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import { serverUrl } from "../support/database.js";
import { RecordingClock } from "../support/recording-clock.js";

const CHANNEL = "agboss_127_watch";
const PAYLOAD = "schema_127";
const LIVENESS = 10;
const HALF = seconds(LIVENESS / 2);
const CONNECTS = { timeout: 15_000 };
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The socket and the TCP keepalive of the `pg` client of the listener. */
function internals(client: pg.Client): { stream: Socket; keepAlive: boolean } {
  const connection: unknown = Reflect.get(client, "connection");
  const stream: unknown = Reflect.get(Object(connection), "stream");
  if (!(stream instanceof Socket)) throw new Error("pg's connection has no socket");
  return { stream, keepAlive: Reflect.get(Object(connection), "_keepAlive") === true };
}

interface Seen {
  /** What the `pg` clients of listeners did, in order: "connect", "end". */
  readonly events: string[];
  /** The listeners' own clients (TCP keepalive on). */
  readonly clients: pg.Client[];
  /** The arguments of each `setKeepAlive`. */
  readonly keepAlives: unknown[][];
}

/** Watches the `pg` clients and sockets made from now on. */
function watchClients(): Seen {
  const seen: Seen = { events: [], clients: [], keepAlives: [] };
  const connect = Object.getOwnPropertyDescriptor(pg.Client.prototype, "connect")?.value as (
    this: pg.Client,
    ...args: unknown[]
  ) => unknown;
  vi.spyOn(pg.Client.prototype, "connect").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    seen.events.push("connect");
    seen.clients.push(this);
    return connect.call(this, ...args) as never;
  });
  const end = Object.getOwnPropertyDescriptor(pg.Client.prototype, "end")?.value as (
    this: pg.Client,
    ...args: unknown[]
  ) => unknown;
  vi.spyOn(pg.Client.prototype, "end").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    seen.events.push("end");
    return end.call(this, ...args) as never;
  });
  const setKeepAlive = Reflect.get(Socket.prototype, "setKeepAlive") as (
    ...args: unknown[]
  ) => Socket;
  vi.spyOn(Socket.prototype, "setKeepAlive").mockImplementation(function (
    this: Socket,
    ...args: unknown[]
  ) {
    seen.keepAlives.push(args);
    return Reflect.apply<Socket, unknown[], Socket>(setKeepAlive, this, args);
  });
  return seen;
}

/** The listener's own socket of its client number `index`. */
const socketOf = (seen: Seen, index: number): Socket => {
  const client = seen.clients[index];
  if (client === undefined) throw new Error(`no client ${String(index)}`);
  return internals(client).stream;
};

interface Rig {
  readonly clock: RecordingClock;
  readonly warnings: string[];
  readonly wakes: () => number;
  readonly seen: Seen;
  readonly options: PostgresListenerOptions;
}

/** The options of a listener on `url`, its clock and what it said. */
function rig(url = serverUrl(), liveness = LIVENESS): Rig {
  const clock = new RecordingClock();
  const warnings: string[] = [];
  let wakes = 0;
  const seen = watchClients();
  return {
    clock,
    warnings,
    wakes: () => wakes,
    seen,
    options: {
      url,
      channel: CHANNEL,
      payload: PAYLOAD,
      clock,
      livenessSeconds: liveness,
      warn: (message) => {
        warnings.push(message);
      },
      onNotify: () => {
        wakes += 1;
      },
    },
  };
}

async function opened(options: PostgresListenerOptions): Promise<PostgresListener> {
  const listener = await PostgresListener.open(options);
  cleanups.push(() => listener.close());
  return listener;
}

/** A proxy to the server and the URL that goes through it. */
async function proxied(): Promise<{ readonly proxy: BlackholeProxy; readonly url: string }> {
  const direct = new URL(serverUrl());
  const proxy = await BlackholeProxy.start({ host: direct.hostname, port: Number(direct.port) });
  cleanups.push(() => proxy.close());
  const through = new URL(direct);
  through.port = String(proxy.port);
  return { proxy, url: through.toString() };
}

async function notify(payload: string): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl() });
  await client.connect();
  try {
    await client.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]);
  } finally {
    await client.end();
  }
}

const notification = (channel: string, payload: string): pg.Notification => ({
  processId: 1,
  channel,
  payload,
});

/** Lets the sockets and the reconnect of a lost connection run. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe("agbossjs/postgres#127: what the listener passes on", () => {
  it("wakes on its channel and its payload only", async () => {
    const r = rig();
    await opened(r.options);
    const client = r.seen.clients[0];
    if (client === undefined) throw new Error("no client");

    client.emit("notification", notification("another_channel", PAYLOAD));
    client.emit("notification", notification(CHANNEL, "another_schema"));
    expect(r.wakes()).toBe(0);

    client.emit("notification", notification(CHANNEL, PAYLOAD));
    expect(r.wakes()).toBe(1);
    await notify(PAYLOAD);
    await vi.waitFor(() => {
      expect(r.wakes()).toBe(2);
    });
  });

  it("asks for TCP keepalive from half of the bound on", async () => {
    const r = rig();
    await opened(r.options);

    expect(r.seen.keepAlives).toEqual([[true, 5000]]);
  });

  it("bounds the first connection by the bound, and drops that timer once it listens", async () => {
    const r = rig();
    await opened(r.options);

    const [connecting, beat] = r.clock.sleeps;
    expect(connecting?.delay).toBe(seconds(LIVENESS));
    expect(connecting?.signal?.aborted).toBe(true);
    expect(beat?.delay).toBe(HALF);
    expect(beat?.signal?.aborted).toBe(false);
  });

  it("a first connection the network swallows fails with why, within the bound", async () => {
    const { proxy, url } = await proxied();
    proxy.swallowNew(true);
    const r = rig(url);

    const opening = PostgresListener.open(r.options);
    const rejected = expect(opening).rejects.toThrow("the database did not answer in time");
    await vi.waitFor(() => {
      expect(r.clock.sleeps).toHaveLength(1);
    });
    await r.clock.advance(seconds(LIVENESS));

    await rejected;
    expect(socketOf(r.seen, 0).destroyed).toBe(true);
  });
});

describe("agbossjs/postgres#127: a connection that fails or ends", () => {
  it("a failed connection says why, stops its ping, and listens again after the first pause", async () => {
    const r = rig();
    await opened(r.options);
    const client = r.seen.clients[0];
    const beat = r.clock.sleeps[1]?.signal;

    client?.emit("error", new Error("boom"));

    expect(r.warnings).toEqual([
      "The child queue's LISTEN connection is lost (its connection failed: boom); listening again",
    ]);
    expect(beat?.aborted).toBe(true);
    expect(r.wakes()).toBe(0);
    await r.clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(r.wakes()).toBe(1);
    }, CONNECTS);
    expect(r.warnings).toHaveLength(1);
  });

  it("an ended connection says so and listens again", async () => {
    const r = rig();
    await opened(r.options);

    r.seen.clients[0]?.emit("end");

    expect(r.warnings).toEqual([
      "The child queue's LISTEN connection is lost (its connection ended); listening again",
    ]);
    await r.clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(r.wakes()).toBe(1);
    }, CONNECTS);
  });

  it("a connection lost again is warned of again, with the pause the first one had", async () => {
    const r = rig();
    await opened(r.options);
    r.seen.clients[0]?.emit("end");
    await r.clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(r.wakes()).toBe(1);
    }, CONNECTS);

    r.seen.clients[1]?.emit("end");

    expect(r.warnings).toHaveLength(2);
    await r.clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(r.wakes()).toBe(2);
    }, CONNECTS);
  });

  it("an attempt that fails is retried after 1, 2, 4, 8, 16 s and then every 30 s", async () => {
    const { proxy, url } = await proxied();
    const r = rig(url, 7);
    await opened(r.options);
    // from now on every attempt is refused at once
    await proxy.close();
    const pauses: number[] = [];
    const isPause = (delay: number): boolean =>
      [1, 2, 4, 8, 16, 30].some((s) => seconds(s) === delay);
    r.seen.clients[0]?.emit("end");

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await vi.waitFor(() => {
        expect(r.clock.sleeps.filter((sleep) => isPause(sleep.delay))).toHaveLength(attempt + 1);
      }, CONNECTS);
      const pause =
        r.clock.sleeps.filter((sleep) => isPause(sleep.delay))[attempt]?.delay ?? seconds(0);
      pauses.push(pause);
      await r.clock.advance(pause);
      await vi.waitFor(() => {
        expect(r.seen.clients).toHaveLength(attempt + 2);
      }, CONNECTS);
      await settled();
    }

    expect(pauses).toEqual([1, 2, 4, 8, 16, 30, 30, 30].map((s) => seconds(s)));
    expect(r.wakes()).toBe(0);
  }, 60_000);
});

describe("agbossjs/postgres#127: how the listener stops", () => {
  it("close() ends the listener, its ping and its connection", async () => {
    const r = rig();
    const listener = await opened(r.options);
    expect(listener.closed).toBe(false);
    const beat = r.clock.sleeps[1]?.signal;

    await listener.close();

    expect(listener.closed).toBe(true);
    expect(beat?.aborted).toBe(true);
    expect(socketOf(r.seen, 0).destroyed).toBe(true);
    // no timer of the clock outlives the close
    expect(r.clock.sleeps.every((sleep) => sleep.signal?.aborted === true)).toBe(true);
  });

  it("close() on a server that never answers the end gives up after half of the bound, not after the bound", async () => {
    const r = rig();
    const listener = await opened(r.options);
    // the orderly end is never answered (a half-open connection)
    vi.spyOn(pg.Client.prototype, "end").mockReturnValue(
      new Promise<never>(() => undefined) as never,
    );

    let closed = false;
    const closing = listener.close().then(() => {
      closed = true;
    });
    await settled();
    expect(closed).toBe(false);
    expect(socketOf(r.seen, 0).destroyed).toBe(false);
    await r.clock.advance(HALF);
    await closing;

    expect(closed).toBe(true);
    expect(socketOf(r.seen, 0).destroyed).toBe(true);
    expect(r.clock.sleeps.every((sleep) => sleep.signal?.aborted === true)).toBe(true);
  });

  it("destroy() drops the connection at once, without the server, and stops the ping", async () => {
    const r = rig();
    const listener = await opened(r.options);
    const beat = r.clock.sleeps[1]?.signal;

    listener.destroy();

    expect(listener.closed).toBe(true);
    expect(beat?.aborted).toBe(true);
    expect(socketOf(r.seen, 0).destroyed).toBe(true);
    await listener.close();
  });

  it("destroy() drops a connection that is still starting, at once", async () => {
    const { proxy, url } = await proxied();
    const r = rig(url);
    const listener = await opened(r.options);
    proxy.cut();
    proxy.swallowNew(true);
    r.seen.clients[0]?.emit("end");
    await r.clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(r.seen.clients).toHaveLength(2);
    }, CONNECTS);
    expect(socketOf(r.seen, 1).destroyed).toBe(false);

    listener.destroy();

    expect(socketOf(r.seen, 1).destroyed).toBe(true);
    await listener.close();
    expect(r.wakes()).toBe(0);
  });

  it("a connection made after destroy() is dropped before it starts", async () => {
    const r = rig();
    let armed = false;
    const held: { listener?: PostgresListener } = {};
    // the options are read when a connection is made: destroy() lands just before it starts
    const options: PostgresListenerOptions = {
      ...r.options,
      get channel() {
        if (armed) {
          armed = false;
          held.listener?.destroy();
        }
        return CHANNEL;
      },
    };
    const listener = await opened(options);
    held.listener = listener;
    r.seen.clients[0]?.emit("end");
    armed = true;
    r.seen.events.length = 0;

    await r.clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(r.seen.clients).toHaveLength(2);
    }, CONNECTS);

    // the first client's hook, then the new client's own: `end()` before it connects
    expect(r.seen.events.slice(0, 3)).toEqual(["end", "end", "connect"]);
    expect(armed).toBe(false);
    await listener.close();
  });

  it("a close that lands as a new connection starts to listen ends that connection and wakes nothing", async () => {
    const r = rig();
    const listener = await opened(r.options);
    r.seen.clients[0]?.emit("end");
    let closing: Promise<void> | undefined;
    r.clock.onSleep = (sleep) => {
      // the bound of the new connection: its timer is dropped just after the connection listens
      if (sleep.delay === seconds(LIVENESS)) {
        r.clock.onSleep = () => undefined;
        sleep.signal?.addEventListener(
          "abort",
          () => {
            closing = listener.close();
          },
          { once: true },
        );
      }
    };

    await r.clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(closing).toBeDefined();
    }, CONNECTS);
    await closing;

    expect(r.seen.clients).toHaveLength(2);
    expect(socketOf(r.seen, 1).destroyed).toBe(true);
    expect(r.wakes()).toBe(0);
    expect(listener.closed).toBe(true);
  });
});

/** The `drop` listeners the listener has on abort signals now, counted by what `pg` clients are made. */
function watchDrops(): () => number {
  const live = new Set<unknown>();
  const named = (listener: unknown): boolean =>
    typeof listener === "function" && listener.name === "drop";
  const add = Reflect.get(EventTarget.prototype, "addEventListener") as (
    ...args: unknown[]
  ) => void;
  const remove = Reflect.get(EventTarget.prototype, "removeEventListener") as (
    ...args: unknown[]
  ) => void;
  vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (
    this: EventTarget,
    ...args: unknown[]
  ) {
    if (args[0] === "abort" && named(args[1])) live.add(args[1]);
    Reflect.apply(add, this, args);
  });
  vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(function (
    this: EventTarget,
    ...args: unknown[]
  ) {
    if (args[0] === "abort" && named(args[1])) live.delete(args[1]);
    Reflect.apply(remove, this, args);
  });
  return () => live.size;
}

describe("agbossjs/postgres#130: a connection that ended leaves nothing on the listener", () => {
  it("N reconnects keep one drop listener (the current connection's), and close() none", async () => {
    const r = rig();
    const drops = watchDrops();
    const listener = await opened(r.options);
    expect(drops()).toBe(1);

    for (let reconnect = 1; reconnect <= 5; reconnect += 1) {
      r.seen.clients[reconnect - 1]?.emit("end");
      await r.clock.advance(seconds(1));
      await vi.waitFor(() => {
        expect(r.wakes()).toBe(reconnect);
      }, CONNECTS);
      // the lost connection's socket closes after its destroy
      await vi.waitFor(() => {
        expect(drops()).toBe(1);
      }, CONNECTS);
    }

    expect(r.seen.clients).toHaveLength(6);
    await listener.close();
    await vi.waitFor(() => {
      expect(drops()).toBe(0);
    }, CONNECTS);
  });

  it("attempts that fail leave none either", async () => {
    const { proxy, url } = await proxied();
    const r = rig(url, 7);
    const drops = watchDrops();
    await opened(r.options);
    await proxy.close();
    r.seen.clients[0]?.emit("end");

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await vi.waitFor(() => {
        expect(r.clock.sleeps.some((sleep) => sleep.delay === seconds(2 ** (attempt - 1)))).toBe(
          true,
        );
      }, CONNECTS);
      await r.clock.advance(seconds(2 ** (attempt - 1)));
      await vi.waitFor(() => {
        expect(r.seen.clients).toHaveLength(attempt + 1);
      }, CONNECTS);
    }

    await vi.waitFor(() => {
      expect(drops()).toBe(0);
    }, CONNECTS);
  }, 60_000);
});
