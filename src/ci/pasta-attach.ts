// The attach helper (T069, T164, slice 23b-1; Owner decisions 2026-10-13): a run with network
// starts bubblewrap with no network of its own, its command waiting behind a gate on fd 4; pasta
// then gives the waiting sandbox a network of its own, and only once pasta is ready does the
// helper write `go` to the gate.
// The factory runs this file as a process of its own, with only PATH in its environment and the
// spec on stdin from factory code, so the runners stay synchronous; it imports only Node's own
// modules, so Node runs it from the source as from the build. It fails closed: if pasta exits or
// is not ready in time, bwrap is killed before the command is released. Bwrap dies with this
// process (--die-with-parent), and pasta too (setpriv --pdeathsig); the factory starts this
// process the same way, so nothing outlives the factory.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';

interface Spec {
  /** bwrap's arguments, with `--info-fd 3`, then the gate reading fd 4 and the command. */
  bwrap: string[];
  /** pasta's arguments, but for the PID of the sandbox it attaches to. */
  pasta: string[];
  /** Where pasta writes its PID once it is ready. */
  pidFile: string;
  readyMs: number;
}

const spec = JSON.parse(readFileSync(0, 'utf8')) as Spec;
/** One JSON line per report on fd 3: the PIDs, readiness, then the outcome. */
const report = (fields: Record<string, unknown>) => {
  writeSync(3, `${JSON.stringify(fields)}\n`);
};
const exit = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : once(child, 'exit').then(() => undefined);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const bwrap = spawn('bwrap', spec.bwrap, {
  stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'],
});
report({ bwrap: bwrap.pid });
// bwrap and the gate close their ends when they exit; that is no error of the helper's.
for (const fd of [3, 4]) (bwrap.stdio[fd] as Readable).on('error', () => undefined);
/** bwrap, then pasta once started. */
const children: ChildProcess[] = [bwrap];
const killAll = () => {
  for (const child of children) child.kill('SIGKILL');
};
// Stopped, as when the app's service stops: the run ends by that signal, which is no failure of
// the helper's.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(signal, () => {
    killAll();
    report({ status: null, signal });
    process.exit(0);
  });

/** The sandbox's PID from bwrap's info fd; undefined when bwrap exits first. */
async function childPid(): Promise<number | undefined> {
  let info = '';
  const fd = bwrap.stdio[3] as Readable;
  const ended = exit(bwrap).then(() => undefined);
  while (!info.includes('}')) {
    const chunk = await Promise.race([once(fd, 'data').then(([d]) => String(d)), ended]);
    if (chunk === undefined) return undefined;
    info += chunk;
  }
  const pid = (JSON.parse(info) as Record<string, unknown>)['child-pid'];
  return typeof pid === 'number' ? pid : undefined;
}

/** Whether pasta wrote its PID file before exiting or running out of time. */
async function ready(child: ChildProcess): Promise<boolean> {
  const state = { exited: false };
  void exit(child).then(() => (state.exited = true));
  for (let waited = 0; waited < spec.readyMs && !state.exited; waited += 20) {
    try {
      if (readFileSync(spec.pidFile, 'utf8').trim() === String(child.pid)) return true;
    } catch {
      // Not written yet.
    }
    await pause(20);
  }
  return false;
}

const pid = await childPid();
if (pid === undefined) {
  // bwrap failed on its own; its error went to stderr.
  report({ status: bwrap.exitCode, signal: bwrap.signalCode });
  process.exit(0);
}
const pasta = spawn('setpriv', ['--pdeathsig', 'KILL', '--', 'pasta', ...spec.pasta, String(pid)], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
children.push(pasta);
let said = '';
pasta.stderr.on('data', (d: Buffer) => (said += d.toString()));
pasta.on('error', (err) => (said += err.message));
report({ pasta: pasta.pid });

if (!(await ready(pasta))) {
  const why =
    pasta.exitCode === null && pasta.signalCode === null
      ? 'pasta was not ready in time'
      : 'pasta exited';
  killAll();
  await Promise.all([exit(bwrap), exit(pasta)]);
  report({ refused: `${why}: ${said.trim()}` });
  process.exit(0);
}
report({ ready: true });
(bwrap.stdio[4] as Writable).end('go\n');
await exit(bwrap);
// pasta has nothing to clean up, and in the foreground it does not stop on SIGTERM.
pasta.kill('SIGKILL');
await exit(pasta);
report({ status: bwrap.exitCode, signal: bwrap.signalCode });
