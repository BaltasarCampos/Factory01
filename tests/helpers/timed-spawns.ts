// The proof that every program the Stop hook starts carries its deadline (T086, slice 28-5c-2): a
// test file mocks `node:child_process` with these pass-throughs, and every program started while a
// stop's deadline runs, without a positive timeout, is listed in `untimed`.
import type * as ChildProcess from 'node:child_process';
import { deadlineActive } from '../../src/cli/deadline.js';

/** The programs started inside a stop with no positive timeout, as `<function> <program>`. */
export const untimed: string[] = [];
/** Every program started inside a stop, so a test can show the check saw them. */
export const timed: string[] = [];

const SPAWNS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const;

/** The mock's factory: `vi.mock('node:child_process', (real) => timedSpawns(real))`. */
export async function timedSpawns(real: () => Promise<unknown>) {
  const cp = (await real()) as typeof ChildProcess;
  const wrapped = Object.fromEntries(
    SPAWNS.map((name) => [
      name,
      (...args: unknown[]) => {
        if (deadlineActive()) {
          const options = args.find(
            (a): a is { timeout?: unknown } =>
              typeof a === 'object' && a !== null && !Array.isArray(a),
          );
          const what = `${name} ${String(args[0])}`;
          (typeof options?.timeout === 'number' && options.timeout > 0 ? timed : untimed).push(
            what,
          );
        }
        return (cp[name] as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  );
  return { ...cp, ...wrapped, default: { ...cp, ...wrapped } };
}
