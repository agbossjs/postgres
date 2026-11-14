import type { Clock } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { Socket } from "node:net";
import pg from "pg";
import { connectTimeoutOf } from "./connect-timeout.js";
import { watchLiveness } from "./heartbeat.js";

/**
 * A `LISTEN` on one channel of the database (agbossjs/agboss#777): a connection of its own, outside
 * the pool — a pooled one goes back to the pool and stops hearing. Idle while nothing is notified:
 * the server pushes each notification, nothing is polled. A connection that fails or ends is
 * opened again after a pause that doubles from 1 s up to 30 s (on the application's `Clock`), and
 * once it listens again `onNotify` is called once: a notification sent while it was down is lost,
 * so the caller looks as if it had heard one. Only notifications whose payload is `payload` (the
 * schema of the stores) are passed on — two applications on one database in two schemas share the
 * channel.
 *
 * A connection that dies silently — a half-open TCP connection behind a NAT or a load balancer: no
 * FIN, no RST — is noticed within `liveness` (agbossjs/agboss#789): a `SELECT 1` over the
 * connection every half of it, the answer due within the other half, and TCP keepalive on its
 * socket. A connection that is not answered is dropped, `warn` says so, and it is replaced and
 * wakes once, as one that failed.
 */
export interface PostgresListenerOptions {
  /** The database, as the pool's. */
  readonly url: string;
  /** The channel, an identifier as it is (no quoting). */
  readonly channel: string;
  /** The payload of this listener's notifications. */
  readonly payload: string;
  readonly clock: Clock;
  /** The longest a silently dead connection goes unnoticed, in seconds. */
  readonly livenessSeconds: number;
  /** Called with a sentence each time the connection is lost (never throws). */
  readonly warn: (message: string) => void;
  readonly onNotify: () => void;
}

/** The pauses before each attempt to listen again; the last one repeats. */
const PAUSES = [1, 2, 4, 8, 16, 30].map((pause) => seconds(pause));

/** A channel listened to until `close()`. */
export class PostgresListener {
  readonly #stopped = new AbortController();
  #client: pg.Client | undefined;
  #beat = new AbortController();
  #socket: Socket | undefined;
  #reconnecting: Promise<void> | undefined;

  private constructor(private readonly options: PostgresListenerOptions) {}

  /** Listens now; rejects when the first connection fails (the caller tries again later). */
  static async open(options: PostgresListenerOptions): Promise<PostgresListener> {
    const listener = new PostgresListener(options);
    await listener.#connect();
    return listener;
  }

  /** Stops listening and ends the connection; a reconnect under way stops too. */
  async close(): Promise<void> {
    this.#stopped.abort();
    this.#beat.abort();
    const client = this.#client;
    this.#client = undefined;
    await this.#reconnecting;
    if (client !== undefined) await this.#ended(client, this.#socket);
  }

  /**
   * Ends `client` in order; a connection that does not answer in time (half of `liveness`, on the
   * clock) is dropped, so `close()` never waits on a silent server.
   */
  async #ended(client: pg.Client, socket: Socket | undefined): Promise<void> {
    const ended = new AbortController();
    const ending = client.end().catch(() => undefined);
    await Promise.race([
      ending,
      this.options.clock.sleep(seconds(this.options.livenessSeconds / 2), ended.signal),
    ]);
    ended.abort();
    socket?.destroy();
  }

  async #connect(): Promise<void> {
    const { url, channel, payload, onNotify, livenessSeconds } = this.options;
    const socket = new Socket();
    const client = new pg.Client({
      connectionString: url,
      keepAlive: true,
      keepAliveInitialDelayMillis: (livenessSeconds / 2) * 1000,
      // agbossjs/agboss#989: a start never answered fails the attempt (a reconnect tries again)
      connectionTimeoutMillis: connectTimeoutOf(url),
      stream: () => socket,
    });
    client.on("notification", (message) => {
      if (message.channel === channel && message.payload === payload) onNotify();
    });
    client.on("error", (error) => {
      this.#lost(client, `its connection failed: ${error.message}`);
    });
    client.on("end", () => {
      this.#lost(client, "its connection ended");
    });
    const opening = new AbortController();
    try {
      await Promise.race([
        client.connect().then(() => client.query(`LISTEN ${channel}`)),
        this.#unanswered(AbortSignal.any([opening.signal, this.#stopped.signal])),
      ]);
    } catch (error) {
      socket.destroy();
      void client.end().catch(() => undefined);
      throw error;
    } finally {
      opening.abort();
    }
    if (this.#stopped.signal.aborted) {
      await this.#ended(client, socket);
      return;
    }
    this.#client = client;
    this.#socket = socket;
    this.#beat = new AbortController();
    void this.#heartbeat(client, this.#beat.signal);
  }

  /** Rejects when `liveness` has passed on the clock (the server is silent) or `signal` aborts. */
  async #unanswered(signal: AbortSignal): Promise<never> {
    await this.options.clock.sleep(seconds(this.options.livenessSeconds), signal);
    throw new Error("the database did not answer in time");
  }

  /** Pings `client` until it is replaced; a connection that does not answer is lost. */
  async #heartbeat(client: pg.Client, signal: AbortSignal): Promise<void> {
    const dead = await watchLiveness({
      clock: this.options.clock,
      livenessSeconds: this.options.livenessSeconds,
      ping: () => client.query("SELECT 1"),
      signal,
    });
    if (dead !== undefined) this.#lost(client, dead);
  }

  /** The connection failed, ended or went silent: open another, unless it is closed or replaced. */
  #lost(client: pg.Client, reason: string): void {
    if (this.#stopped.signal.aborted || this.#client !== client) return;
    this.#client = undefined;
    this.#beat.abort();
    this.options.warn(`The child queue's LISTEN connection is lost (${reason}); listening again`);
    // a silent connection never answers an orderly end: its socket is dropped
    this.#socket?.destroy();
    void client.end().catch(() => undefined);
    this.#reconnecting = this.#reconnect().finally(() => {
      this.#reconnecting = undefined;
    });
  }

  async #reconnect(): Promise<void> {
    const signal = this.#stopped.signal;
    const isStopped = (): boolean => signal.aborted;
    for (let attempt = 0; ; attempt += 1) {
      const pause = PAUSES[Math.min(attempt, PAUSES.length - 1)] ?? seconds(30);
      await this.options.clock.sleep(pause, signal).catch(() => undefined);
      if (isStopped()) return;
      if (await this.#connected()) {
        if (this.#client !== undefined) this.options.onNotify();
        return;
      }
    }
  }

  /** One attempt to listen again: `false` when it failed. */
  async #connected(): Promise<boolean> {
    try {
      await this.#connect();
      return true;
    } catch {
      return false;
    }
  }
}
