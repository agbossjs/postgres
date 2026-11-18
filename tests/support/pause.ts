import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Socket } from "node:net";
import { Clock } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { outputOf } from "./process.js";

/**
 * A server of the stop tests' own (agbossjs/agboss#923): a container started for the test file,
 * capped (`--cpus 1`, a memory limit), paused with `docker pause` (the server stops answering, its
 * sockets stay open — a hung network, a frozen server) and removed after. Without Docker the
 * tests are skipped. Nothing else shares it, so pausing it disturbs no other test.
 */
const docker = async (...args: string[]): Promise<string> =>
  (await outputOf("docker", args)).trim();

export const HAS_DOCKER = await docker("info").then(
  () => true,
  () => false,
);

/** A free TCP port of the host. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `probe` until it passes (a server booting), up to `tries` seconds. */
export async function untilReady(probe: () => Promise<unknown>, tries = 60): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await probe();
      return;
    } catch (error) {
      if (attempt >= tries) throw error;
      await sleep(1000);
    }
  }
}

/** The container a test file pauses. */
export interface PausableServer {
  readonly url: string;
  pause(): Promise<void>;
  unpause(): Promise<void>;
  remove(): Promise<void>;
}

export function serverOf(name: string, url: string): PausableServer {
  return {
    url,
    pause: async () => {
      await docker("pause", name);
    },
    unpause: async () => {
      // not paused: nothing to undo
      await docker("unpause", name).catch(() => undefined);
    },
    remove: async () => {
      // already gone: nothing to remove
      await docker("rm", "-f", name).catch(() => undefined);
    },
  };
}

/** A PostgreSQL in its own container, ready. */
export async function startPostgres(): Promise<PausableServer> {
  const name = `agboss-923-postgres-${randomUUID()}`;
  const port = await freePort();
  await docker(
    ...[
      "run",
      "-d",
      "--name",
      name,
      "--cpus",
      process.env.AGBOSS_PAUSE_CPUS ?? "1",
      "--memory",
      "512m",
    ],
    ...["-e", "POSTGRES_PASSWORD=pw", "-p", `127.0.0.1:${String(port)}:5432`, "postgres:16"],
  );
  await untilReady(async () => {
    await docker("exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1");
  });
  await sleep(2000); // the entrypoint restarts the server once after its first start
  await untilReady(async () => {
    await docker("exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1");
  });
  return serverOf(name, `postgres://postgres:pw@127.0.0.1:${String(port)}/postgres`);
}

/**
 * A PostgreSQL with `ssl=on` and a self-signed certificate (made here with `openssl`), its own
 * container: a client of `sslmode=no-verify` upgrades its socket to TLS (agbossjs/agboss#954).
 */
export async function startPostgresTls(): Promise<PausableServer> {
  const name = `agboss-954-postgres-tls-${randomUUID()}`;
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "agboss-954-tls-"));
  await outputOf(
    "openssl",
    ["req", "-new", "-x509", "-days", "2", "-nodes", "-subj", "/CN=127.0.0.1"].concat([
      "-out",
      join(dir, "server.crt"),
      "-keyout",
      join(dir, "server.key"),
    ]),
  );
  // the key must belong to the server's user with mode 0600: copied inside, the mount is read-only
  const prepare =
    "cp /tls/server.crt /tls/server.key /var/lib/postgresql/ && chown postgres /var/lib/postgresql/server.* && chmod 600 /var/lib/postgresql/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key";
  await docker(
    ...[
      "run",
      "-d",
      "--name",
      name,
      "--cpus",
      process.env.AGBOSS_PAUSE_CPUS ?? "1",
      "--memory",
      "512m",
    ],
    ...["-e", "POSTGRES_PASSWORD=pw", "-v", `${dir}:/tls:ro`],
    ...["-p", `127.0.0.1:${String(port)}:5432`, "--entrypoint", "sh", "postgres:16", "-c", prepare],
  );
  await untilReady(async () => {
    await docker("exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1");
  });
  await sleep(2000);
  await untilReady(async () => {
    await docker("exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1");
  });
  return serverOf(
    name,
    `postgres://postgres:pw@127.0.0.1:${String(port)}/postgres?sslmode=no-verify`,
  );
}

/** `"returned"` when `work` ended first, `"hung"` when `limit` ms passed (a race of events, not a duration). */
export async function endsWithin(
  work: Promise<unknown>,
  limit: number,
): Promise<"returned" | "hung"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => {
      resolve("hung");
    }, limit);
  });
  try {
    return await Promise.race([work.then(() => "returned" as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Unhandled rejections seen from now on (the late failure of an abandoned call must not be one). */
export function watchUnhandled(): { readonly seen: unknown[]; stop(): void } {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    seen,
    stop: () => {
      process.off("unhandledRejection", onUnhandled);
    },
  };
}

/** The system's time, as the application's clock is in production (the core's own is not exported). */
export class RealClock extends Clock {
  now(): Date {
    return new Date();
  }

  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

/**
 * The sockets this process opens to `port` from now on, counted by the sockets themselves
 * (`destroyed`), not by a client's own `isOpen` (false while a client is closing, its socket still
 * up: agbossjs/agboss#954).
 */
export function trackSockets(port: number): { open(): number; stop(): void } {
  const sockets: Socket[] = [];
  const original: unknown = Reflect.get(Socket.prototype, "connect");
  if (typeof original !== "function") throw new Error("net.Socket has no connect");
  const patched = function (this: Socket, ...args: unknown[]): Socket {
    // a client passes the port itself (pg) or its options, alone or in an array (node-redis)
    const first: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const target =
      typeof first === "object" && first !== null ? (first as { port?: number }).port : first;
    if (target === port) sockets.push(this);
    Reflect.apply(original, this, args);
    return this;
  };
  Reflect.set(Socket.prototype, "connect", patched);
  return {
    open: () => sockets.filter((socket) => !socket.destroyed).length,
    stop: () => {
      Reflect.set(Socket.prototype, "connect", original);
    },
  };
}
