import { VirtualClock } from "@agboss/core/testing";
import type { Milliseconds } from "@agboss/core/units";

/** One sleep made on a `RecordingClock`. */
export interface RecordedSleep {
  readonly delay: Milliseconds;
  readonly signal: AbortSignal | undefined;
}

/** A `VirtualClock` that keeps the length and the signal of every sleep made on it. */
export class RecordingClock extends VirtualClock {
  readonly sleeps: RecordedSleep[] = [];
  /** Called with each sleep as it starts, before it waits. */
  onSleep: (sleep: RecordedSleep) => void = () => undefined;

  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    const sleep = { delay, signal };
    this.sleeps.push(sleep);
    this.onSleep(sleep);
    return super.sleep(delay, signal);
  }
}
