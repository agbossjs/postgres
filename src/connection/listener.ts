import type { Clock } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import pg from "pg";

/**
 * A `LISTEN` on one channel of the database (agbossjs/agboss#777): a connection of its own, outside
 * the pool — a pooled one goes back to the pool and stops hearing. Idle while nothing is notified:
 * the server pushes each notification, nothing is polled. A connection that fails or ends is
 * opened again after a pause that doubles from 1 s up to 30 s (on the application's `Clock`), and
 * once it listens again `onNotify` is called once: a notification sent while it was down is lost,
 * so the caller looks as if it had heard one. Only notifications whose payload is `payload` (the
 * schema of the stores) are passed on — two applications on one database in two schemas share the
 * channel.
 */
export interface PostgresListenerOptions {
  /** The database, as the pool's. */
  readonly url: string;
  /** The channel, an identifier as it is (no quoting). */
  readonly channel: string;
  /** The payload of this listener's notifications. */
  readonly payload: string;
  readonly clock: Clock;
  readonly onNotify: () => void;
}

/** The pauses before each attempt to listen again; the last one repeats. */
const PAUSES = [1, 2, 4, 8, 16, 30].map((pause) => seconds(pause));

/** A channel listened to until `close()`. */
export class PostgresListener {
  readonly #stopped = new AbortController();
  #client: pg.Client | undefined;
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
    const client = this.#client;
    this.#client = undefined;
    await this.#reconnecting;
    await client?.end().catch(() => undefined);
  }

  async #connect(): Promise<void> {
    const { url, channel, payload, onNotify } = this.options;
    const client = new pg.Client({ connectionString: url, keepAlive: true });
    client.on("notification", (message) => {
      if (message.channel === channel && message.payload === payload) onNotify();
    });
    client.on("error", () => {
      this.#lost(client);
    });
    client.on("end", () => {
      this.#lost(client);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${channel}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.#stopped.signal.aborted) {
      await client.end().catch(() => undefined);
      return;
    }
    this.#client = client;
  }

  /** The connection failed or ended: open another, unless it is closed or already replaced. */
  #lost(client: pg.Client): void {
    if (this.#stopped.signal.aborted || this.#client !== client) return;
    this.#client = undefined;
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
