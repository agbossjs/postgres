/**
 * agbossjs/agboss#989: the tests' server URL names the address the server answers on, never
 * `localhost` — a connection to `localhost:<port>` whose IPv6 attempt found nothing listening could
 * be given that port as its own source and connect to itself, and `pg` then waits forever.
 */
import { createServer, isIP, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serverUrl } from "../support/database.js";
import { pinnedUrl } from "../support/pinned-url.js";

let ipv4Only: Server;
let port = 0;

beforeAll(async () => {
  // as Docker publishes a port: on 127.0.0.1, nothing on ::1
  ipv4Only = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => ipv4Only.listen(0, "127.0.0.1", resolve));
  const address = ipv4Only.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  port = address.port;
});

afterAll(async () => {
  await new Promise((resolve) => ipv4Only.close(resolve));
});

describe("#989: the test server's host is pinned to the address that answers", () => {
  it("localhost on a server listening on 127.0.0.1 only → 127.0.0.1; the rest of the URL kept", async () => {
    const url = `postgres://app:se%40cret@localhost:${String(port)}/app?application_name=probe`;

    expect(await pinnedUrl(url)).toBe(
      `postgres://app:se%40cret@127.0.0.1:${String(port)}/app?application_name=probe`,
    );
  });

  it("a server on both ::1 and 127.0.0.1 (CI's services) → 127.0.0.1: no bracketed IPv6 host", async () => {
    const both = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) =>
      both.listen({ port: 0, host: "::", ipv6Only: false }, resolve),
    );
    const address = both.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    expect(await pinnedUrl(`postgres://app@localhost:${String(address.port)}/x`)).toBe(
      `postgres://app@127.0.0.1:${String(address.port)}/x`,
    );
    await new Promise((resolve) => both.close(resolve));
  });

  it("an address already pinned is left as it is", async () => {
    const url = `postgres://app:secret@127.0.0.1:${String(port)}/app`;

    expect(await pinnedUrl(url)).toBe(url);
    expect(await pinnedUrl("postgres://app@[::1]:5432/app")).toBe("postgres://app@[::1]:5432/app");
  });

  it("the global setup pinned this run's URL: its host is an address", () => {
    expect(isIP(new URL(serverUrl()).hostname.replace(/^\[|\]$/gu, ""))).not.toBe(0);
  });
});
