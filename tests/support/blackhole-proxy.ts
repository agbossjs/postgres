import net from "node:net";

/** What happens to the client message an armed fault matched (agbossjs/agboss#1017, postgres#113). */
type Fault =
  /** Forwarded; the server's answer dropped, the connection reset soon after (`resetOn`). */
  | { readonly kind: "reset" }
  /** Never forwarded: the connection is reset at once, the server never sees it (`withholdOn`). */
  | { readonly kind: "withhold" }
  /** Forwarded; the server's answer replaced by `answer`, then the connection ends (`answerOn`). */
  | { readonly kind: "answer"; readonly answer: Uint8Array };

/** One client connection through the proxy and its upstream. */
interface Leg {
  readonly client: net.Socket;
  readonly upstream: net.Socket | undefined;
  silent: boolean;
  /** The fault this leg's client message matched: what becomes of the server's answer. */
  fault: Fault | undefined;
}

/**
 * A TCP proxy that can go silent (agbossjs/agboss#789): `cut()` makes every connection open now
 * drop its bytes in both directions — no FIN, no RST, the proxy keeps both sockets open and
 * acknowledged, as a NAT or a load balancer that lost its state does. A new connection is
 * forwarded as usual, or (`swallowNew`) accepted and swallowed. `socket.destroy()` on the client
 * side is no substitute: that sends a FIN or an RST.
 */
export class BlackholeProxy {
  readonly #legs = new Set<Leg>();
  #swallowing = false;
  #armed: { readonly text: string; readonly fault: Fault } | undefined;

  private constructor(
    private readonly server: net.Server,
    private readonly target: { readonly host: string; readonly port: number },
  ) {}

  /** Listens on a free port of 127.0.0.1, forwarding to `target`. */
  static async start(target: {
    readonly host: string;
    readonly port: number;
  }): Promise<BlackholeProxy> {
    const server = net.createServer();
    const proxy = new BlackholeProxy(server, target);
    server.on("connection", (client) => {
      proxy.#accept(client);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return proxy;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string")
      throw new Error("the proxy is not listening");
    return address.port;
  }

  /** Every connection open now goes silent, for good. */
  cut(): void {
    for (const leg of this.#legs) leg.silent = true;
  }

  /** Connections made from now on are accepted and swallowed (`true`), or forwarded (`false`). */
  swallowNew(on: boolean): void {
    this.#swallowing = on;
  }

  /**
   * Once a client message contains `text` (a simple query's text, e.g. `COMMIT`), it is forwarded,
   * the server's answer to it is dropped and the connection is reset (agbossjs/agboss#1017): the
   * statement took effect on the server and its answer never reached the client. One-shot.
   */
  resetOn(text: string): void {
    this.#armed = { text, fault: { kind: "reset" } };
  }

  /**
   * Once a client message contains `text`, it is not forwarded and the connection is reset: the
   * statement never reached the server, and the client cannot tell (postgres#113). One-shot.
   */
  withholdOn(text: string): void {
    this.#armed = { text, fault: { kind: "withhold" } };
  }

  /**
   * Once a client message contains `text`, it is forwarded, the server's answer is replaced by
   * `answer` (a pooler's error, garbage) and the connection then ends (postgres#113): the
   * statement took effect, the client hears something else. One-shot.
   */
  answerOn(text: string, answer: Uint8Array): void {
    this.#armed = { text, fault: { kind: "answer", answer } };
  }

  /** How many connections are open (for a test that checks nothing leaked). */
  get open(): number {
    return this.#legs.size;
  }

  async close(): Promise<void> {
    for (const leg of this.#legs) {
      leg.client.destroy();
      leg.upstream?.destroy();
    }
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  #accept(client: net.Socket): void {
    const upstream = this.#swallowing ? undefined : net.connect(this.target);
    const leg: Leg = { client, upstream, silent: this.#swallowing, fault: undefined };
    this.#legs.add(leg);
    const drop = (): void => {
      this.#legs.delete(leg);
      client.destroy();
      upstream?.destroy();
    };
    client.on("data", (bytes) => {
      const armed = this.#armed;
      if (armed !== undefined && bytes.includes(armed.text)) {
        this.#armed = undefined;
        leg.fault = armed.fault;
      }
      if (leg.fault?.kind === "withhold") drop();
      else if (!leg.silent) upstream?.write(bytes);
    });
    upstream?.on("data", (bytes) => {
      if (leg.fault === undefined) {
        if (!leg.silent) client.write(bytes);
        return;
      }
      if (leg.fault.kind === "answer") {
        // the client hears the answer, then the end; the server's side is closed under it
        leg.silent = true;
        client.end(leg.fault.answer);
        upstream.destroy();
        return;
      }
      // the server answered: its answer is never heard
      setTimeout(drop, 20);
    });
    // a close or an error is passed on only while the leg is alive: a silent leg ends with its own side
    client.on("close", drop);
    client.on("error", () => undefined);
    upstream?.on("close", () => {
      if (!leg.silent) drop();
    });
    upstream?.on("error", () => undefined);
  }
}
