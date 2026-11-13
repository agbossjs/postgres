import { lookup } from "node:dns/promises";
import { connect, isIP } from "node:net";

/**
 * The test server's URL with its host pinned to the address that answers (agbossjs/agboss#989):
 * `localhost` resolves to `::1` and `127.0.0.1`, and Docker publishes a port on `127.0.0.1` only.
 * A client tries `::1` first; when nothing listens there and the port is in the ephemeral range,
 * the kernel can give that attempt the same port as its own source — the socket connects to
 * itself, and `pg` waits for its own startup message to be answered. The explorer's thousands of
 * connections per run made that a gate hung for 17 minutes. An address something listens on is
 * never handed out as a source port, so a pinned host cannot connect to itself.
 */
export async function pinnedUrl(url: string): Promise<string> {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(host) !== 0) return url;
  const port = Number(parsed.port === "" ? "5432" : parsed.port);
  // an IPv4 address: a bracketed IPv6 host is not read by every client (node-redis's `url.parse`);
  // a server on IPv6 alone keeps its name
  for (const { address } of await lookup(host, { all: true, family: 4 }))
    if (await isListening(address, port)) {
      parsed.hostname = address;
      return parsed.toString();
    }
  return url;
}

/** Whether a server listens on `address`:`port` — a socket connected to itself is not one. */
const isListening = (address: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: address, port, autoSelectFamily: false });
    socket.once("connect", () => {
      const isSelf = socket.localPort === port && socket.localAddress === socket.remoteAddress;
      socket.destroy();
      resolve(!isSelf);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
