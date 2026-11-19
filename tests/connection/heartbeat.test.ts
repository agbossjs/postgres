/**
 * agbossjs/postgres#127: `watchLiveness`, the ping of the child queue's LISTEN connection
 * (agbossjs/agboss#789), on its own: a ping every half of the bound, an answer due in the other
 * half, every timer on the clock, and why a connection is dead said in a sentence.
 */
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { watchLiveness } from "../../src/connection/heartbeat.js";
import { RecordingClock } from "../support/recording-clock.js";

const BOUND = 10;
const HALF_MS = seconds(BOUND / 2);

/** A watch of `ping` that has not ended; `outcome()` is why it called `onDead`, `undefined` while it did not. */
function watching(ping: () => Promise<unknown>) {
  const clock = new RecordingClock();
  const stop = new AbortController();
  let settled = false;
  const dead: string[] = [];
  const done = watchLiveness({
    clock,
    livenessSeconds: BOUND,
    ping,
    signal: stop.signal,
    onDead: (why) => {
      dead.push(why);
    },
  }).then(() => {
    settled = true;
  });
  return {
    clock,
    stop,
    done,
    settled: () => settled,
    outcome: () => dead[0],
    deaths: () => dead.length,
  };
}

describe("agbossjs/postgres#127: watchLiveness", () => {
  it("sleeps half of the bound before the first ping, and pings nothing while the watch is aborted in that sleep", async () => {
    let pings = 0;
    const watch = watching(() => {
      pings += 1;
      return Promise.resolve();
    });
    await watch.clock.advance(seconds(1));
    expect(watch.clock.sleeps.map((sleep) => sleep.delay)).toEqual([HALF_MS]);
    expect(pings).toBe(0);

    watch.stop.abort();
    await watch.done;

    expect(pings).toBe(0);
    expect(watch.settled()).toBe(true);
    expect(watch.outcome()).toBeUndefined();
  });

  it("pings every half of the bound for as long as the answers come, and ends with nothing when aborted", async () => {
    let pings = 0;
    const watch = watching(() => {
      pings += 1;
      return Promise.resolve();
    });

    await watch.clock.advance(seconds(5));
    expect(pings).toBe(1);
    await watch.clock.advance(seconds(5));
    expect(pings).toBe(2);
    expect(watch.settled()).toBe(false);
    await watch.clock.advance(seconds(5));
    expect(pings).toBe(3);

    watch.stop.abort();
    await watch.done;
    expect(watch.outcome()).toBeUndefined();
  });

  it("an answered ping drops its deadline, so no sleep of the clock outlives it", async () => {
    const watch = watching(() => Promise.resolve());

    await watch.clock.advance(seconds(5));

    // the sleeps: the wait for the first ping, the deadline of that ping (answered, so aborted),
    // and the wait for the next one
    const [, deadline] = watch.clock.sleeps;
    expect(deadline?.delay).toBe(HALF_MS);
    expect(deadline?.signal?.aborted).toBe(true);
    watch.stop.abort();
    await watch.done;
  });

  it("a ping not answered in the other half is dead: the sentence says for how long", async () => {
    const watch = watching(() => new Promise<never>(() => undefined));

    await watch.clock.advance(seconds(5));
    expect(watch.settled()).toBe(false);
    await watch.clock.advance(seconds(5));
    await watch.done;

    expect(watch.outcome()).toBe("no answer to a ping in 5 s");
    expect(watch.deaths()).toBe(1);
  });

  it("a ping that fails is dead at once, with the error's message", async () => {
    const watch = watching(() => Promise.reject(new Error("connection terminated")));

    await watch.clock.advance(seconds(5));
    await watch.done;

    expect(watch.outcome()).toBe("the ping failed: connection terminated");
  });

  it("a ping that fails with a thing that is no error is dead too", async () => {
    const watch = watching(
      () =>
        new Promise((_resolve, reject) => {
          const fail: (reason: unknown) => void = reject;
          fail("not an error");
        }),
    );

    await watch.clock.advance(seconds(5));
    await watch.done;

    expect(watch.outcome()).toBe("the ping failed: error");
  });

  it("aborted while a ping is waiting for its answer: nothing is dead, the deadline is dropped", async () => {
    const watch = watching(() => new Promise<never>(() => undefined));
    await watch.clock.advance(seconds(5));

    watch.stop.abort();
    await watch.done;

    expect(watch.outcome()).toBeUndefined();
    expect(watch.clock.sleeps[1]?.signal?.aborted).toBe(true);
  });

  it("the deadline of a ping ends when the watch ends, not only when the ping answers", async () => {
    const watch = watching(() => new Promise<never>(() => undefined));
    await watch.clock.advance(seconds(5));
    const deadline = watch.clock.sleeps[1]?.signal;
    expect(deadline?.aborted).toBe(false);

    watch.stop.abort();
    await watch.done;

    expect(deadline?.aborted).toBe(true);
  });
});
