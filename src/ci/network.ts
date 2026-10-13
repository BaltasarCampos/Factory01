// Network through pasta (T069, T164, slice 23b-1; design v1.8, Owner decisions 2026-10-13): the
// test sandbox's install, and the deploy's install and app, get a network of their own from pasta
// in attach mode, never bwrap's shared one: the internet, but not services listening only on the
// laptop or its local sockets. Attach mode, since pasta's spawn mode cannot mount a matching /proc
// on the Owner's laptop. pasta's arguments are fixed here; the app's port is the only variable,
// an integer from factory code or the signed config.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RefusedError } from '../cli/env.js';
import { SPAWN } from './sandbox.js';

/**
 * Where a run sends its DNS queries: pasta forwards those, and only those, to the laptop's own
 * resolver, which may listen on the laptop's loopback (systemd-resolved) and is otherwise out of
 * reach. A link-local address no network routes.
 */
export const DNS_FORWARD = '169.254.1.53';

/** How long pasta has to set up the sandbox's network before the run is refused. */
const READY_MS = 10_000;

/**
 * The gate the command waits behind, inside the sandbox: it runs the command only after reading
 * `go` on fd 4, which the helper writes once pasta is ready. Not bwrap's `--block-fd`, which an
 * end of file releases too: if the helper dies, the gate reads nothing and the command never
 * starts. Fds 3 and 4 are closed before the command runs.
 */
const GATE = [
  '/bin/sh',
  '-c',
  'IFS= read -r go <&4 && [ "$go" = go ] || exit 125; exec 3<&- 4<&-; exec "$@"',
  'gate',
];

/**
 * pasta's arguments: in the foreground, configuring the sandbox's network, forwarding nothing
 * from the sandbox to the laptop and, from the laptop, only the app's port, on its loopback.
 */
export function pastaArgs(port: number | undefined, pidFile: string): string[] {
  return [
    ...['-f', '-q', '--config-net'],
    ...['-t', port === undefined ? 'none' : `127.0.0.1/${String(port)}`],
    ...['-u', 'none', '-T', 'none', '-U', 'none'],
    // The gateway's address is the real gateway, never the laptop itself.
    '--no-map-gw',
    ...['--dns-forward', DNS_FORWARD],
    ...['-P', pidFile],
  ];
}

/** The helper, beside this file: its source under Vitest, its build in the CLI. */
const HELPER = fileURLToPath(
  new URL(`./pasta-attach${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

export interface AttachCommand {
  command: string;
  args: string[];
  /** The spec, for the helper's stdin. */
  input: string;
  /** The folder for pasta's PID file and the run's resolv.conf, to remove afterwards. */
  dir: string;
}

/**
 * How to run `argv` with the bwrap arguments `args` and pasta's network: the helper, under
 * `setpriv --pdeathsig KILL` so it dies with the factory. Its folder is made here with `mkdtemp`,
 * outside the workspace and the app folder.
 */
export function attachCommand(
  args: readonly string[],
  argv: readonly string[],
  port: number | undefined,
  readyMs = READY_MS,
): AttachCommand {
  const dir = mkdtempSync(join(tmpdir(), 'factory-pasta-'));
  writeFileSync(join(dir, 'resolv.conf'), `nameserver ${DNS_FORWARD}\n`);
  // The run's resolv.conf names only pasta's address, wherever /etc/resolv.conf leads.
  const resolver =
    lstatSync('/etc/resolv.conf', { throwIfNoEntry: false })?.isSymbolicLink() === true
      ? realpathSync('/etc/resolv.conf')
      : '/etc/resolv.conf';
  const pidFile = join(dir, 'pasta.pid');
  const spec = {
    bwrap: [
      ...args,
      ...['--ro-bind', join(dir, 'resolv.conf'), resolver],
      ...['--info-fd', '3'],
      ...GATE,
      ...argv,
    ],
    pasta: pastaArgs(port, pidFile),
    pidFile,
    readyMs,
  };
  return {
    command: 'setpriv',
    args: ['--pdeathsig', 'KILL', '--', process.execPath, HELPER],
    input: JSON.stringify(spec),
    dir,
  };
}

export type Attached = SpawnSyncReturns<string> & { pasta: number | undefined };

/**
 * Runs `argv` in bubblewrap with pasta's network, through the helper; `outer` holds only PATH.
 * Refuses, with `what` and pasta's own error, when pasta fails: the command never starts
 * without its network.
 */
export function attached(
  args: readonly string[],
  argv: readonly string[],
  port: number | undefined,
  outer: NodeJS.ProcessEnv,
  what: string,
): Attached {
  const command = attachCommand(args, argv, port);
  try {
    const run = spawnSync(command.command, command.args, {
      ...SPAWN,
      env: { PATH: outer.PATH ?? '' },
      input: command.input,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const reports = (run.output[3] ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const said = (key: string) => reports.find((r) => key in r)?.[key];
    const refused = said('refused');
    if (refused !== undefined)
      throw new RefusedError(
        `${what}: ${typeof refused === 'string' ? refused : JSON.stringify(refused)}`,
      );
    const status = said('status');
    if (run.error !== undefined || run.status !== 0 || status === undefined)
      throw new RefusedError(
        `${what}: ${run.error?.message ?? `the attach helper failed: ${run.stderr.trim()}`}`,
      );
    return {
      ...run,
      status: typeof status === 'number' ? status : null,
      signal: (said('signal') as NodeJS.Signals | null | undefined) ?? null,
      pasta: said('pasta') as number | undefined,
    };
  } finally {
    rmSync(command.dir, { recursive: true, force: true });
  }
}
