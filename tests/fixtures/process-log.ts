/**
 * What a fixture process tells its test (tests/processes/): one JSON object per stdout line — what
 * its components did, its replies to the test's commands. And the gate its held steps wait at:
 * closed unless the process was started with `AGBOSS_PROCESS_GATE=open`, opened by the test's
 * `open` command. The gate is the process's own memory: two processes share nothing but the
 * database.
 */

/** One stdout line: `{ "event": …, …fields }`. */
export function emit(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

const gate = {
  isOpen: process.env.AGBOSS_PROCESS_GATE === "open",
  waiting: [] as (() => void)[],
};

/** Lets every held step of this process go on, and every later one through at once. */
export function openGate(): void {
  gate.isOpen = true;
  for (const go of gate.waiting.splice(0)) go();
}

/** Until the gate opens; rejects with the signal's reason when the step is stopped first. */
export function atGate(signal: AbortSignal): Promise<void> {
  if (gate.isOpen) return Promise.resolve();
  return new Promise((resolve, reject) => {
    gate.waiting.push(resolve);
    signal.addEventListener("abort", () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("the step was stopped"));
    });
  });
}
