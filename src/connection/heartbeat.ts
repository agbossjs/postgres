import type { Clock } from "@agboss/core";
import { seconds } from "@agboss/core/units";

/** What `watchLiveness` needs of a connection. */
export interface LivenessOptions {
  readonly clock: Clock;
  /** The longest a dead connection goes unnoticed, in seconds: a ping every half, an answer due in the other. */
  readonly livenessSeconds: number;
  /** One cheap command over the connection; it rejects when the connection fails. */
  readonly ping: () => Promise<unknown>;
  /** Ends the watch (the connection is closed or replaced). */
  readonly signal: AbortSignal;
  /** Called once, with why the connection is dead, when the watch ends because it is. */
  readonly onDead: (why: string) => void;
}

/**
 * Whether `signal` has aborted. A function of its own, called in the loop: a mutant of its body is counted by
 * Stryker on every call, so a loop that then never ends is a Timeout of its hit limit within a second; the
 * same test as a closure made before the loop is evaluated once, and the loop spins until the clock's limit
 * (or the heap's end) — agbossjs/agboss#1367.
 */
export function hasEnded(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Pings a connection every half of `liveness` until `signal` aborts (agbossjs/agboss#789): a
 * half-open TCP connection (a NAT or a load balancer that dropped its state) answers nothing and
 * fails nothing, so only a command that is not answered shows it. Every timer is on the `Clock`.
 * Ends when `signal` aborts, saying nothing, or when the connection is dead — the ping failed, or
 * was not answered within the other half of `livenessSeconds` — after calling `onDead` with why.
 */
export async function watchLiveness(options: LivenessOptions): Promise<void> {
  const { clock, livenessSeconds, ping, signal, onDead } = options;
  const half = seconds(livenessSeconds / 2);
  for (;;) {
    await clock.sleep(half, signal);
    if (hasEnded(signal)) return;
    const answered = new AbortController();
    const outcome = await Promise.race([
      ping().then(
        () => "answered",
        (error: unknown) => `the ping failed: ${error instanceof Error ? error.message : "error"}`,
      ),
      clock
        .sleep(half, AbortSignal.any([signal, answered.signal]))
        .then(() => `no answer to a ping in ${String(livenessSeconds / 2)} s`),
    ]);
    answered.abort();
    if (hasEnded(signal)) return;
    if (outcome !== "answered") {
      onDead(outcome);
      return;
    }
  }
}
