// The deploy sandbox (T069; design v1.8, Owner decisions 2026-10-13): the product's install and
// build, the running app and its daily backup run only inside bubblewrap. Which run sees what is
// the one fixed table below, in factory code: nothing in the project can widen it. Every run gets
// the system folders and the Node install read-only, a private /tmp, its own PID namespace (so a
// process it leaves behind dies with it) and session, an empty environment but for PATH, HOME and
// the app's settings path, and nothing else of the home folder: not ~/.factory, ~/.ssh, ~/.npmrc,
// ~/.gitconfig or the Owner's checkout. The install and the app get network only through pasta
// (slice 23b-1): the internet, never services listening only on the laptop or its local sockets.
// Without a working bubblewrap or pasta the deploy refuses.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import { attached } from '../ci/network.js';
import { baseBinds, DEV, nodeBin, probeBwrap, SPAWN } from '../ci/sandbox.js';
import { RefusedError } from '../cli/env.js';

export type DeployRun = 'install' | 'build' | 'app' | 'backup';

/** Where the app folder's parts appear inside every run. */
export const INSIDE = {
  code: '/app/code',
  data: '/app/data',
  backups: '/app/backups',
  settings: '/app/settings.env',
} as const;

interface Row {
  code: 'rw' | 'ro';
  data?: 'rw';
  backups?: 'rw';
  settings?: 'ro';
  /** Network through pasta; the app's alone forwards a port, its own. */
  network: boolean;
  home: string;
}

/**
 * Which run sees what. The install and the build write only their new release, the install alone
 * with the network; the app writes only its data and reads its settings; the backup writes only
 * the data (SQLite's lock files) and the backups, with no network and no settings.
 */
export const RUNS: Readonly<Record<DeployRun, Readonly<Row>>> = Object.freeze({
  install: { code: 'rw', network: true, home: `${INSIDE.code}/.home` },
  build: { code: 'rw', network: false, home: `${INSIDE.code}/.home` },
  app: { code: 'ro', data: 'rw', settings: 'ro', network: true, home: INSIDE.data },
  backup: { code: 'ro', data: 'rw', backups: 'rw', network: false, home: INSIDE.data },
});

/** The app's folders on the laptop: outside `~/.factory` and outside the Owner's checkout. */
export interface AppFolder {
  root: string;
  releases: string;
  data: string;
  backups: string;
  /** Written by the Owner; mounted read-only into the app, never in the repository. */
  settings: string;
}

export function appFolder(home: string, repo: string): AppFolder {
  const root = join(home, '.local', 'share', 'factory', 'apps', ...repo.split('/'));
  return {
    root,
    releases: join(root, 'releases'),
    data: join(root, 'data'),
    backups: join(root, 'backups'),
    settings: join(home, '.config', 'factory', 'apps', ...repo.split('/'), 'settings.env'),
  };
}

/** The bubblewrap arguments for `run` of `release`, a folder under `app.releases`. */
export function deployArgs(
  run: DeployRun,
  app: AppFolder,
  release: string,
  port?: number,
): string[] {
  const row = RUNS[run];
  const bind = (access: 'rw' | 'ro' | undefined, from: string, to: string) =>
    access === undefined ? [] : [access === 'rw' ? '--bind' : '--ro-bind', from, to];
  return [
    ...['--unshare-all', '--unshare-pid'],
    '--die-with-parent',
    // Its own session: nothing inside can type into the Owner's terminal through TIOCSTI.
    '--new-session',
    '--clearenv',
    ...['--setenv', 'PATH', `${nodeBin()}:/usr/bin:/bin`],
    ...['--setenv', 'HOME', row.home],
    ...(row.settings === undefined ? [] : ['--setenv', 'APP_SETTINGS', INSIDE.settings]),
    // Where the app keeps its data: the product's own code reads it, never a path it assumes.
    ...(row.data === undefined ? [] : ['--setenv', 'APP_DATA', INSIDE.data]),
    // Only the app listens, on the port pasta forwards: a number, so --setenv shows no secret.
    ...(run === 'app' && port !== undefined ? ['--setenv', 'PORT', String(appPort(port))] : []),
    ...baseBinds(),
    ...['--proc', '/proc', ...DEV, '--tmpfs', '/tmp'],
    ...bind(row.code, release, INSIDE.code),
    ...bind(row.data, app.data, INSIDE.data),
    ...bind(row.backups, app.backups, INSIDE.backups),
    ...bind(row.settings, app.settings, INSIDE.settings),
    ...['--chdir', INSIDE.code],
  ];
}

/** The app's port: an integer from 1024 to 65535, from factory code or the signed config. */
export function appPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new RefusedError(
      `the app's port must be an integer from 1024 to 65535, not ${String(port)}`,
    );
  return port;
}

export type DeployRunner = (run: DeployRun, argv: readonly string[]) => SpawnSyncReturns<string>;

const NO_PASTA =
  'factory deploy gives the product network only through pasta, which failed (install it with: sudo apt install passt)';

/**
 * The runner for `release`, after bubblewrap's probe and pasta's, together, on the install's
 * arguments: a missing `bwrap` or `pasta`, or user namespaces that do not work, refuse, and
 * nothing ever runs unsandboxed or on the shared network. The app run forwards `port`. With
 * `service`, as `factory service` runs the app, output goes to this process's and nothing
 * times out.
 */
export function deployRunner(
  app: AppFolder,
  release: string,
  env: NodeJS.ProcessEnv,
  port?: number,
  service = false,
): DeployRunner {
  const outer = probeBwrap(
    deployArgs('build', app, release),
    env,
    'factory deploy runs the product only inside bubblewrap, which failed (install it with: sudo apt install bubblewrap; it also needs working user namespaces)',
  );
  attached(deployArgs('install', app, release), ['true'], undefined, outer, NO_PASTA);
  return (run, argv) => {
    if (run === 'app' && port === undefined)
      throw new RefusedError('the app run needs its port: nothing was started');
    const args = deployArgs(run, app, release, port);
    if (!RUNS[run].network)
      return spawnSync('bwrap', [...args, ...argv], {
        env: outer,
        ...(service ? { encoding: 'utf8', stdio: 'inherit' } : SPAWN),
      });
    const forward = run === 'app' && port !== undefined ? appPort(port) : undefined;
    return attached(args, argv, forward, outer, NO_PASTA, service);
  };
}
