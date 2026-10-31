import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

/**
 * The application instances of a process test: each a separate `node` process running
 * `instance.ts` (its own pool on the test's schema), driven over stdin and read over stdout — one
 * JSON object per line. Every instance still running after a test is killed. The mesh peer the
 * instances trust (`orders-application`) signs with this file's key pair: a test signs as it.
 */

const SCRIPT = fileURLToPath(new URL("./instance.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The Ed25519 pair of the mesh peer `orders-application`: its private key signs a test's envelopes. */
export const ORDERS_KEYS = generateKeyPairSync("ed25519");

/** The environment of a process of the instances' application (an instance, a CLI command). */
export const processEnvOf = (url: string): NodeJS.ProcessEnv => ({
  ...process.env,
  AGBOSS_PROCESS_DATABASE_URL: url,
  AGBOSS_PROCESS_MESH_PEER_KEY: ORDERS_KEYS.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
});

/** One line an instance wrote. */
export type InstanceEvent = Readonly<Record<string, unknown>> & { readonly event: string };

export interface Instance {
  /** Its `ApplicationContext.instanceId`. */
  readonly instanceId: string;
  /** Where it serves A2A (`http://127.0.0.1:<port>`). */
  readonly a2aUrl: string;
  /** Every event it wrote so far, in order. */
  readonly events: () => readonly InstanceEvent[];
  /** The first event (written so far or later) `matches` accepts. */
  readonly next: (
    matches: (event: InstanceEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<InstanceEvent>;
  /** Sends a command; resolves with its reply's result, rejects with its error. */
  readonly send: (op: string, fields?: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** SIGSTOP: frozen where it is — no timer, no renewal, no write — until `thaw`. */
  readonly freeze: () => void;
  /** SIGCONT: a frozen instance runs on from where it was, its timers late. */
  readonly thaw: () => void;
  /** SIGKILL: no shutdown hook runs, its lease is never released. Resolves with the exit signal. */
  readonly kill: () => Promise<NodeJS.Signals | null>;
}

const running = new Set<ChildProcess>();

afterEach(() => {
  for (const child of running) child.kill("SIGKILL");
  running.clear();
});

/** Lines of JSON from a stream: anything else (the framework's own log) is left out. */
function readEvents(child: ChildProcess, into: InstanceEvent[], onEvent: () => void): void {
  let rest = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const lines = (rest + chunk.toString()).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines.filter((text) => text.startsWith("{"))) {
      into.push(JSON.parse(line) as InstanceEvent);
      onEvent();
    }
  });
}

/** Starts an instance on `url` and waits until it is ready; `gate: "open"` lets held steps through. */
export async function launch(
  url: string,
  options: { readonly gate?: "open" } = {},
): Promise<Instance> {
  const child = spawn(process.execPath, ["--import", "tsx", SCRIPT], {
    cwd: ROOT,
    env: { ...processEnvOf(url), AGBOSS_PROCESS_GATE: options.gate ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  running.add(child);
  const events: InstanceEvent[] = [];
  const watchers = new Set<() => void>();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  readEvents(child, events, () => {
    for (const watch of [...watchers]) watch();
  });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.on("exit", (_, signal) => {
      resolve(signal);
    });
  });
  const next = (matches: (event: InstanceEvent) => boolean, timeoutMs = 20_000) =>
    new Promise<InstanceEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        watchers.delete(look);
        reject(
          new Error(
            `no matching event in ${String(timeoutMs)} ms; saw ${JSON.stringify(events)}; stderr: ${stderr}`,
          ),
        );
      }, timeoutMs);
      const look = (): void => {
        const found = events.find(matches);
        if (found === undefined) return;
        clearTimeout(timer);
        watchers.delete(look);
        resolve(found);
      };
      watchers.add(look);
      look();
    });
  let sent = 0;
  const send = async (
    op: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> => {
    sent += 1;
    const id = sent;
    child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`);
    const reply = await next((event) => event.event === "reply" && event.id === id, 90_000);
    if (typeof reply.error === "string") {
      const failure = new Error(reply.error);
      failure.name = String(reply.errorName);
      throw failure;
    }
    return reply.result;
  };
  const kill = async (): Promise<NodeJS.Signals | null> => {
    child.kill("SIGKILL");
    running.delete(child);
    return exited;
  };
  const freeze = (): void => {
    child.kill("SIGSTOP");
  };
  const thaw = (): void => {
    child.kill("SIGCONT");
  };
  const ready = await next((event) => event.event === "ready", 30_000);
  return {
    instanceId: String(ready.instanceId),
    a2aUrl: `http://127.0.0.1:${String(ready.port)}`,
    events: () => events,
    next,
    send,
    freeze,
    thaw,
    kill,
  };
}

/** The events of `kind` an instance wrote. */
export const eventsOf = (instance: Instance, kind: string): readonly InstanceEvent[] =>
  instance.events().filter((event) => event.event === kind);
