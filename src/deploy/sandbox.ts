// The deploy sandbox (T069; design v1.8, Owner decisions 2026-10-13): the product's install and
// build, the running app and its daily backup run only inside bubblewrap. Which run sees what is
// the one fixed table below, in factory code: nothing in the project can widen it. Every run gets
// the system folders and the Node install read-only, a private /tmp, its own PID namespace (so a
// process it leaves behind dies with it) and session, an empty environment but for PATH, HOME and
// the app's settings path, and nothing else of the home folder: not ~/.factory, ~/.ssh, ~/.npmrc,
// ~/.gitconfig or the Owner's checkout. Without a working bubblewrap the deploy refuses.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import { baseBinds, nodeBin, probeBwrap, SPAWN } from '../ci/sandbox.js';

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
export function deployArgs(run: DeployRun, app: AppFolder, release: string): string[] {
  const row = RUNS[run];
  const bind = (access: 'rw' | 'ro' | undefined, from: string, to: string) =>
    access === undefined ? [] : [access === 'rw' ? '--bind' : '--ro-bind', from, to];
  return [
    ...['--unshare-all', '--unshare-pid'],
    ...(row.network ? ['--share-net'] : []),
    '--die-with-parent',
    // Its own session: nothing inside can type into the Owner's terminal through TIOCSTI.
    '--new-session',
    '--clearenv',
    ...['--setenv', 'PATH', `${nodeBin()}:/usr/bin:/bin`],
    ...['--setenv', 'HOME', row.home],
    ...(row.settings === undefined ? [] : ['--setenv', 'APP_SETTINGS', INSIDE.settings]),
    ...baseBinds(row.network),
    ...['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'],
    ...bind(row.code, release, INSIDE.code),
    ...bind(row.data, app.data, INSIDE.data),
    ...bind(row.backups, app.backups, INSIDE.backups),
    ...bind(row.settings, app.settings, INSIDE.settings),
    ...['--chdir', INSIDE.code],
  ];
}

export type DeployRunner = (run: DeployRun, argv: readonly string[]) => SpawnSyncReturns<string>;

/**
 * The runner for `release`, after bubblewrap's own probe: a missing `bwrap`, or user namespaces
 * that do not work, refuse, and nothing ever runs unsandboxed.
 */
export function deployRunner(
  app: AppFolder,
  release: string,
  env: NodeJS.ProcessEnv,
): DeployRunner {
  const outer = probeBwrap(
    deployArgs('build', app, release),
    env,
    'factory deploy runs the product only inside bubblewrap, which failed (install it with: sudo apt install bubblewrap; it also needs working user namespaces)',
  );
  return (run, argv) =>
    spawnSync('bwrap', [...deployArgs(run, app, release), ...argv], { env: outer, ...SPAWN });
}
