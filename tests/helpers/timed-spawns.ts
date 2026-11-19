// The proof that every program the Stop hook starts carries its deadline (T086, slice 28-5c-2): a
// test file mocks `node:child_process` with these pass-throughs, and every program started while a
// stop's deadline runs, without a positive timeout no longer than the time left, is listed in
// `untimed`.
import type * as ChildProcess from 'node:child_process';
import { expect } from 'vitest';
import { msLeft } from '../../src/cli/deadline.js';

/** The programs started inside a stop with no fitting timeout, as `<function> <program>`. */
export const untimed: string[] = [];
/** Every program started inside a stop, so a test can show the check saw them. */
export const timed: string[] = [];
/** Each of `timed`'s timeouts, in ms, in the same order. */
export const timeouts: number[] = [];

/**
 * How far a timeout may pass the time left read here: `timeLeft` reads the clock a moment before
 * the program starts, never minutes.
 */
const SLACK = 1000;

let stopped = false;

/** A stop row's run, so the check after it requires that it saw programs. */
export function stopRow<T>(run: Promise<T>): Promise<T> {
  stopped = true;
  return run;
}

/** For `afterEach`: no program untimed, and a stop row saw some; then clears both. */
export function checkSpawns() {
  const seen = timed.splice(0);
  timeouts.splice(0);
  const ran = stopped;
  stopped = false;
  expect(untimed.splice(0)).toEqual([]);
  if (ran) expect(seen, 'programs the stop started').not.toEqual([]);
}

const SPAWNS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const;

/** The mock's factory: `vi.mock('node:child_process', (real) => timedSpawns(real))`. */
export async function timedSpawns(real: () => Promise<unknown>) {
  const cp = (await real()) as typeof ChildProcess;
  const wrapped = Object.fromEntries(
    SPAWNS.map((name) => [
      name,
      (...args: unknown[]) => {
        const left = msLeft();
        if (left !== undefined) {
          const options = args.find(
            (a): a is { timeout?: unknown } =>
              typeof a === 'object' && a !== null && !Array.isArray(a),
          );
          const what = `${name} ${String(args[0])}`;
          const timeout = options?.timeout;
          if (typeof timeout === 'number' && timeout > 0 && timeout <= left + SLACK) {
            timed.push(what);
            timeouts.push(timeout);
          } else untimed.push(`${what} (timeout ${String(timeout)}, ${String(left)} ms left)`);
        }
        return (cp[name] as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  );
  return { ...cp, ...wrapped, default: { ...cp, ...wrapped } };
}
