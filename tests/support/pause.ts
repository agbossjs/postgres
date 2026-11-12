import { execFileSync } from "node:child_process";
import { createServer } from "node:net";

/**
 * A server of the stop tests' own (agbossjs/agboss#923): a container started for the test file,
 * capped (`--cpus 1`, a memory limit), paused with `docker pause` (the server stops answering, its
 * sockets stay open — a hung network, a frozen server) and removed after. Without Docker the
 * tests are skipped. Nothing else shares it, so pausing it disturbs no other test.
 */
const docker = (...args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export const HAS_DOCKER = ((): boolean => {
  try {
    docker("info");
    return true;
  } catch {
    return false;
  }
})();

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
export async function untilReady(probe: () => void, tries = 60): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      probe();
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
  pause(): void;
  unpause(): void;
  remove(): void;
}

export function serverOf(name: string, url: string): PausableServer {
  return {
    url,
    pause: () => {
      docker("pause", name);
    },
    unpause: () => {
      try {
        docker("unpause", name);
      } catch {
        // not paused
      }
    },
    remove: () => {
      try {
        docker("rm", "-f", name);
      } catch {
        // already gone
      }
    },
  };
}

/** A PostgreSQL in its own container, ready. */
export async function startPostgres(): Promise<PausableServer> {
  const name = `agboss-923-postgres-${String(process.pid)}`;
  const port = await freePort();
  docker(
    ...["run", "-d", "--name", name, "--cpus", "1", "--memory", "512m"],
    ...["-e", "POSTGRES_PASSWORD=pw", "-p", `127.0.0.1:${String(port)}:5432`, "postgres:16"],
  );
  await untilReady(() => {
    docker("exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1");
  });
  await sleep(2000); // the entrypoint restarts the server once after its first start
  await untilReady(() => {
    docker("exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1");
  });
  return serverOf(name, `postgres://postgres:pw@127.0.0.1:${String(port)}/postgres`);
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
