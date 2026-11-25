// One deadline for every program a run of the Stop hook starts (T086, slice 28-5c-2): git in the
// sandbox or the factory's own clone, gh, and bubblewrap's probe. Each program is synchronous or
// already started, so no single timer can stop it: each takes the time left as its own timeout.
import { EnvironmentError } from './env.js';

let deadline: { at: number; ms: number } | undefined;

/** `run` with every program it starts bounded, all together, by `ms`. */
export async function withDeadline<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const before = deadline;
  deadline = { at: Date.now() + ms, ms };
  try {
    return await run();
  } finally {
    deadline = before;
  }
}

/** Whether a deadline is running, for the test that proves every program carries it. */
export const deadlineActive = () => deadline !== undefined;

/** The ms left before the running deadline, or undefined for none; for the same test. */
export const msLeft = () => (deadline === undefined ? undefined : deadline.at - Date.now());

/**
 * For tests only: ends a deadline a row left running. A row cut off by its own timeout never
 * settles its stop, so `withDeadline` never restores what it set, and every later row of the file
 * would run under it. Production never calls this.
 */
export const clearDeadlineForTests = () => {
  deadline = undefined;
};

/** The deadline's refusal: the factory's own limit, which the session cannot fix. */
export class DeadlinePassed extends EnvironmentError {}
const refusal = (ms: number) =>
  new DeadlinePassed(
    `the Stop hook ran past its ${String(ms / 1000)} s limit, so the factory could not check the session's output: the factory's own limit, which this session cannot fix`,
  );

/** A program's timeout, and how its end reads against the deadline. */
export interface Bound {
  timeout: number | undefined;
  /**
   * The deadline's refusal for a program that ended without finishing, else none: one that timed
   * out on the deadline's time left always gets it, never decided by a second reading of the
   * clock, whose own timer can fire a moment before `Date.now()` reaches the deadline (Owner
   * decision 2026-11-19); one that timed out on its own shorter cap never does.
   */
  ended: (timedOut: boolean) => DeadlinePassed | undefined;
}

/**
 * The bound for a program about to start: its timeout is `cap`, or the time left when a deadline
 * runs and that is less, read from the clock once, so always at least 1, never 0, which Node reads
 * as no limit. With no time left it refuses to start the program. Every caller uses this.
 */
export function bound(cap?: number): Bound {
  if (deadline === undefined) return { timeout: cap, ended: () => undefined };
  const { ms } = deadline;
  const left = deadline.at - Date.now();
  if (left <= 0) throw refusal(ms);
  const own = cap !== undefined && cap < left;
  return {
    timeout: own ? cap : left,
    ended: (timedOut) => (timedOut ? (own ? undefined : refusal(ms)) : pastDeadline()),
  };
}

/** The deadline's refusal once it has passed, for a program that ended without finishing; else none. */
export function pastDeadline(): DeadlinePassed | undefined {
  return deadline !== undefined && Date.now() >= deadline.at ? refusal(deadline.ms) : undefined;
}
