// A session's claude contained in a PID namespace of its own (T061, T125's findings 2 and 3; Owner
// decision 2026-11-12), with the real bwrap: Claude Code starts each Bash command in a session and
// process group of its own, outside claude's, so only the namespace ends them. Whether the factory
// side is SIGKILLed or the bwrap it started is killed alone, nothing of the session is left, a
// setsid background task and a nested bwrap included, and sessionRunning reads it as ended.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { CONTAIN, groupRecord, sessionRunning } from '../../src/dispatcher/launcher/local.js';
import { tempDir } from '../helpers/keys.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
/** Its own setsid'd background task, and a nested bwrap in the shape Claude Code starts one. */
const SCRIPT = [
  "setsid sh -c 'sleep 300' &",
  "bwrap --new-session --die-with-parent --unshare-net --unshare-pid --ro-bind / / --dev /dev --proc /proc sh -c 'sleep 300' &",
  'sleep 300',
].join('\n');
const PATH = '/usr/bin:/bin';

/** The host pids of every process carrying `FACTORY_SESSION=<id>`, the bwrap's own included. */
function carrying(id: string): number[] {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((pid) => {
      try {
        const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
        return environ.split('\0').includes(`FACTORY_SESSION=${id}`);
      } catch {
        return false;
      }
    })
    .map(Number);
}

/** The session's folder in a home of the test's own, with `pgid` recorded as its group. */
function recorded(id: string, pgid: number) {
  const home = realpathSync(tempDir());
  const dir = join(home, '.factory', 'sessions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'group.json'), JSON.stringify(groupRecord(pgid)));
  return home;
}

function cleanup(id: string, ...children: ChildProcess[]) {
  onTestFinished(() => {
    for (const child of children) child.kill('SIGKILL');
    for (const pid of carrying(id)) process.kill(pid, 'SIGKILL');
  });
}

/** Every process of the script has started: two sleeps, the nested bwrap's included, and more. */
async function started(id: string) {
  await vi.waitFor(
    () => {
      expect(carrying(id).length).toBeGreaterThanOrEqual(8);
    },
    {
      timeout: 20_000,
      interval: 100,
    },
  );
}

describe("a session's claude in a PID namespace of its own (T061)", { timeout: 60_000 }, () => {
  it('leaves nothing when the factory side is SIGKILLed, and the session reads as ended', async () => {
    const id = randomUUID();
    const vite = join(ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');
    const helper = join(ROOT, 'tests', 'helpers', 'contained.ts');
    const factory = spawn(process.execPath, [vite, '--root', ROOT, helper], {
      env: { PATH, SCRIPT, SESSION: id },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    cleanup(id, factory);
    const pgid = await new Promise<number>((resolve, reject) => {
      factory.stdout.on('data', (chunk: Buffer) => {
        resolve(Number(chunk.toString().trim()));
      });
      factory.on('exit', () => {
        reject(new Error('the factory side ended before the spawn'));
      });
    });
    await started(id);
    const home = recorded(id, pgid);
    expect(sessionRunning(home, id)).toMatch(/is still running/);

    factory.kill('SIGKILL');

    await vi.waitFor(
      () => {
        expect(carrying(id)).toEqual([]);
      },
      { timeout: 5_000 },
    );
    expect(sessionRunning(home, id)).toBeUndefined();
  });

  it('gives claude its grace when the factory side is signalled: it traps TERM and finishes', async () => {
    const id = randomUUID();
    const done = join(realpathSync(tempDir()), 'done');
    // A second after its TERM, as claude stops its commands, it writes a file.
    const script = `trap 'sleep 1; echo > ${done}; exit 0' TERM; sleep 300 & wait`;
    const vite = join(ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');
    const helper = join(ROOT, 'tests', 'helpers', 'contained.ts');
    const factory = spawn(process.execPath, [vite, '--root', ROOT, helper], {
      env: { PATH, SCRIPT: script, SESSION: id },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    cleanup(id, factory);
    await new Promise<void>((resolve) =>
      factory.stdout.once('data', () => {
        resolve();
      }),
    );
    await vi.waitFor(() => {
      expect(carrying(id).length).toBeGreaterThanOrEqual(3);
    });
    const exited = new Promise<number | null>((resolve) => factory.on('exit', resolve));

    factory.kill('SIGTERM');

    expect(await exited).toBe(143);
    expect(existsSync(done)).toBe(true);
    expect(carrying(id)).toEqual([]);
  });

  it('leaves nothing when the bwrap it started is SIGKILLed alone, its group untouched', async () => {
    const id = randomUUID();
    const bwrap = spawn('bwrap', [...CONTAIN, 'sh', '-c', SCRIPT], {
      env: { PATH, FACTORY_SESSION: id },
      stdio: 'ignore',
      detached: true,
    });
    cleanup(id, bwrap);
    await started(id);
    const pgid = bwrap.pid ?? 0;
    const home = recorded(id, pgid);
    expect(sessionRunning(home, id)).toMatch(/is still running/);

    // The leader alone, never its group: the namespace, not a group signal, ends the rest.
    process.kill(pgid, 'SIGKILL');

    await vi.waitFor(
      () => {
        expect(carrying(id)).toEqual([]);
      },
      { timeout: 5_000 },
    );
    expect(sessionRunning(home, id)).toBeUndefined();
  });
});
