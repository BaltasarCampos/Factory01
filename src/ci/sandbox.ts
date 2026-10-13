// The laptop sandbox (T164, design v1.8, Owner decisions 2026-10-09): pull request code (the
// `npm ci --ignore-scripts` install and every Vitest run) runs outside GitHub Actions only inside
// bubblewrap, with no home folder, no agent sockets, an empty environment, no network for the
// tests and only the run's temp folder writable. Without a working bubblewrap the run is refused;
// there is no unsandboxed fallback. CI needs none: its runner is thrown away after the job.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RefusedError } from '../cli/env.js';

/** Runs `argv` with `cwd` as its working folder; the network is only ever on for the install. */
export type Runner = (
  argv: readonly string[],
  cwd: string,
  network?: boolean,
) => SpawnSyncReturns<string>;

export const SPAWN = {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
  timeout: 30 * 60 * 1000,
} as const;

/** `factory ci <check>` runs pull request code unsandboxed only on GitHub's runner. */
export const inGithubActions = (env: NodeJS.ProcessEnv) => env.GITHUB_ACTIONS === 'true';

/**
 * The factory's own folder: its built CLI (`dist/`), its dependencies (Vitest, tsc and ESLint
 * among them) and the release's configs (`factory/`).
 */
export const factoryRoot = () =>
  fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

/** The npm package that `npm` beside Node resolves to, as nvm or a system install lays it out. */
export function npmCli(): string {
  const link = join(dirname(process.execPath), 'npm');
  if (!existsSync(link)) throw new RefusedError(`no npm beside ${process.execPath}`);
  const cli = realpathSync(link);
  if (!cli.endsWith('/bin/npm-cli.js')) throw new RefusedError(`${link} is not npm's CLI: ${cli}`);
  return cli;
}

const ro = (path: string) => ['--ro-bind', path, path];

/** The folder of the Node binary every sandbox runs, by its real path (nvm's lives under home). */
export const nodeBin = () => dirname(realpathSync(process.execPath));

/**
 * Read-only binds every sandbox gets: the system folders, then, with the network on, the resolver
 * that /etc/resolv.conf links to (systemd's, under /run), that one file, never the rest of /run;
 * then the Node install: its binary's folder and the npm package `npm` beside it resolves to.
 */
export function baseBinds(network: boolean): string[] {
  const system = [
    '/usr',
    '/bin',
    ...readdirSync('/').flatMap((n) => (/^lib/.test(n) ? [`/${n}`] : [])),
    '/etc',
  ];
  const resolver =
    network && lstatSync('/etc/resolv.conf', { throwIfNoEntry: false })?.isSymbolicLink() === true
      ? ro(realpathSync('/etc/resolv.conf'))
      : [];
  return [...system.flatMap(ro), ...resolver, ...ro(nodeBin()), ...ro(dirname(dirname(npmCli())))];
}

/**
 * Runs bubblewrap's own probe (`bwrap <args> true`) and refuses, with `what` and bwrap's own
 * error, if it fails; never an unsandboxed fallback. Returns the outer environment: `bwrap` is
 * found on the caller's PATH, and nothing else of the environment reaches it.
 */
export function probeBwrap(args: readonly string[], env: NodeJS.ProcessEnv, what: string) {
  const outer = { PATH: env.PATH ?? '' };
  const probe = spawnSync('bwrap', [...args, 'true'], { env: outer, encoding: 'utf8' });
  if (probe.error !== undefined || probe.status !== 0)
    throw new RefusedError(`${what}: ${probe.error?.message ?? probe.stderr.trim()}`);
  return outer;
}

/**
 * The bubblewrap arguments for a run in `work` (made by `mkdtemp`), starting in `cwd`, with the
 * folders in `readOnly`, inside `work`, bound read-only over its writable bind.
 */
export function sandboxArgs(
  work: string,
  cwd: string,
  network: boolean,
  readOnly: readonly string[] = [],
): string[] {
  const root = factoryRoot();
  return [
    '--unshare-all',
    // Its own PID namespace, which --unshare-all includes too: nothing a run leaves behind keeps
    // writing into `work` afterwards.
    '--unshare-pid',
    ...(network ? ['--share-net'] : []),
    '--die-with-parent',
    // Its own session: sandboxed code cannot type into the Owner's terminal through TIOCSTI.
    '--new-session',
    '--clearenv',
    ...['--setenv', 'PATH', `${nodeBin()}:/usr/bin:/bin`],
    ...['--setenv', 'HOME', join(work, 'home')],
    ...['--setenv', 'npm_config_cache', join(work, 'npm-cache')],
    ...baseBinds(network),
    ...['--ro-bind-try', join(root, 'dist'), join(root, 'dist')],
    ...ro(join(root, 'factory')),
    ...ro(join(root, 'node_modules')),
    ...['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'],
    ...['--bind', work, work],
    ...readOnly.flatMap((dir) => ['--ro-bind', dir, dir]),
    ...['--chdir', cwd],
  ];
}

/**
 * The one runner for pull request code outside CI. `work` is the run's temp folder, the only one
 * writable inside. Probes bubblewrap first and refuses, with bwrap's own error, if it fails.
 */
export function sandboxed(work: string, env: NodeJS.ProcessEnv): Runner {
  for (const dir of ['home', 'npm-cache']) mkdirSync(join(work, dir), { recursive: true });
  const outer = probeBwrap(
    sandboxArgs(work, work, false),
    env,
    'pull request code runs on this machine only inside bubblewrap, which failed (install it with: sudo apt install bubblewrap)',
  );
  return (argv, cwd, network = false) =>
    spawnSync('bwrap', [...sandboxArgs(work, cwd, network, installed(work, network)), ...argv], {
      env: outer,
      ...SPAWN,
    });
}

/**
 * After the install, its folder, bound read-only into every later run as the factory's own tools
 * are, so one run cannot change the packages the next one loads. It must still be the real
 * folder the install wrote: bwrap would follow a link put in its place.
 */
function installed(work: string, network: boolean): string[] {
  const install = join(work, 'install');
  const stat = lstatSync(install, { throwIfNoEntry: false });
  if (network || stat === undefined) return [];
  if (!stat.isDirectory() || realpathSync(install) !== install)
    throw new RefusedError(`${install} is not a folder: refusing to bind it into a run`);
  return [install];
}

/** The runner in GitHub Actions: the job's environment, less Vitest's and Node's own options. */
export function unsandboxed(env: NodeJS.ProcessEnv): Runner {
  const clean = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('VITEST') && name !== 'NODE_OPTIONS'),
  );
  return ([command = '', ...args], cwd) => spawnSync(command, args, { cwd, env: clean, ...SPAWN });
}
