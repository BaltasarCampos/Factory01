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

/** The deadline's refusal: the factory's own limit, which the session cannot fix. */
const refusal = (ms: number) =>
  new EnvironmentError(
    `the Stop hook ran past its ${String(ms / 1000)} s limit, so the factory could not check the session's output: the factory's own limit, which this session cannot fix`,
  );

/**
 * The timeout for a program about to start, in ms: `cap`, or the time left when a deadline runs and
 * that is less, read from the clock once, so always at least 1, never 0, which Node reads as no
 * limit. With no time left it refuses to start the program.
 */
export function timeLeft(cap?: number): number | undefined {
  if (deadline === undefined) return cap;
  const left = deadline.at - Date.now();
  if (left <= 0) throw refusal(deadline.ms);
  return Math.min(cap ?? left, left);
}

/** The deadline's refusal once it has passed, for a program that ended without finishing; else none. */
export function pastDeadline(): EnvironmentError | undefined {
  return deadline !== undefined && Date.now() >= deadline.at ? refusal(deadline.ms) : undefined;
}
