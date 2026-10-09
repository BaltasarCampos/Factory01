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

const SPAWN = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60 * 1000 } as const;

/** `factory ci <check>` runs pull request code unsandboxed only on GitHub's runner. */
export const inGithubActions = (env: NodeJS.ProcessEnv) => env.GITHUB_ACTIONS === 'true';

/** The factory's own folder: its built CLI (`dist/`) and its dependencies, Vitest among them. */
const factoryRoot = () => fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

/** The npm package that `npm` beside Node resolves to, as nvm or a system install lays it out. */
export function npmCli(): string {
  const link = join(dirname(process.execPath), 'npm');
  if (!existsSync(link)) throw new RefusedError(`no npm beside ${process.execPath}`);
  const cli = realpathSync(link);
  if (!cli.endsWith('/bin/npm-cli.js')) throw new RefusedError(`${link} is not npm's CLI: ${cli}`);
  return cli;
}

/** The bubblewrap arguments for a run in `work` (made by `mkdtemp`), starting in `cwd`. */
export function sandboxArgs(work: string, cwd: string, network: boolean): string[] {
  const node = dirname(realpathSync(process.execPath));
  const root = factoryRoot();
  const ro = (path: string) => ['--ro-bind', path, path];
  const system = [
    '/usr',
    '/bin',
    ...readdirSync('/').flatMap((n) => (/^lib/.test(n) ? [`/${n}`] : [])),
    '/etc',
  ];
  // With the network on, a resolver that /etc/resolv.conf links to (systemd's, under /run) is
  // bound too: that one file, never the rest of /run.
  const resolver =
    network && lstatSync('/etc/resolv.conf', { throwIfNoEntry: false })?.isSymbolicLink() === true
      ? ro(realpathSync('/etc/resolv.conf'))
      : [];
  return [
    '--unshare-all',
    ...(network ? ['--share-net'] : []),
    '--die-with-parent',
    // Its own session: sandboxed code cannot type into the Owner's terminal through TIOCSTI.
    '--new-session',
    '--clearenv',
    ...['--setenv', 'PATH', `${node}:/usr/bin:/bin`],
    ...['--setenv', 'HOME', join(work, 'home')],
    ...['--setenv', 'npm_config_cache', join(work, 'npm-cache')],
    ...system.flatMap(ro),
    ...resolver,
    ...ro(node),
    ...ro(dirname(dirname(npmCli()))),
    ...['--ro-bind-try', join(root, 'dist'), join(root, 'dist')],
    ...ro(join(root, 'node_modules')),
    ...['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'],
    ...['--bind', work, work],
    ...['--chdir', cwd],
  ];
}

/**
 * The one runner for pull request code outside CI. `work` is the run's temp folder, the only one
 * writable inside. Probes bubblewrap first and refuses, with bwrap's own error, if it fails.
 */
export function sandboxed(work: string, env: NodeJS.ProcessEnv): Runner {
  for (const dir of ['home', 'npm-cache']) mkdirSync(join(work, dir), { recursive: true });
  // `bwrap` is found on the caller's PATH; nothing else of the environment reaches it.
  const outer = { PATH: env.PATH ?? '' };
  const probe = spawnSync('bwrap', [...sandboxArgs(work, work, false), 'true'], {
    env: outer,
    encoding: 'utf8',
  });
  if (probe.error !== undefined || probe.status !== 0)
    throw new RefusedError(
      `pull request code runs on this machine only inside bubblewrap, which failed (install it with: sudo apt install bubblewrap): ${probe.error?.message ?? probe.stderr.trim()}`,
    );
  return (argv, cwd, network = false) =>
    spawnSync('bwrap', [...sandboxArgs(work, cwd, network), ...argv], { env: outer, ...SPAWN });
}

/** The runner in GitHub Actions: the job's environment, less Vitest's and Node's own options. */
export function unsandboxed(env: NodeJS.ProcessEnv): Runner {
  const clean = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('VITEST') && name !== 'NODE_OPTIONS'),
  );
  return ([command = '', ...args], cwd) => spawnSync(command, args, { cwd, env: clean, ...SPAWN });
}
