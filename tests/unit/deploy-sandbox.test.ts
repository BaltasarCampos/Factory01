// Which deploy run sees what (T069, slice 23a; Owner decisions 2026-10-13): one fixed table in
// factory code, a test per row. Every run gets the system folders and the Node install read-only,
// even under the home folder, and nothing else; the bubblewrap arguments come only from here.
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pastaArgs } from '../../src/ci/network.js';
import { npmCli, sandboxArgs } from '../../src/ci/sandbox.js';
import { appFolder, appPort, deployArgs, RUNS, type DeployRun } from '../../src/deploy/sandbox.js';

const HOME = '/home/owner';
const app = appFolder(HOME, 'owner/project');
const RELEASE = `${app.releases}/${'a'.repeat(40)}-20261013T153000Z`;
const node = dirname(realpathSync(process.execPath));
const npm = dirname(dirname(npmCli()));

/** Each bind as [flag, source, destination]. */
function binds(args: readonly string[]): [string, string, string][] {
  return args.flatMap((a, i) =>
    /^--(?:ro-|dev-)?bind(?:-try)?$/.test(a)
      ? [[a, args[i + 1] ?? '', args[i + 2] ?? ''] as [string, string, string]]
      : [],
  );
}
/** The environment the run starts with: `--setenv` pairs after `--clearenv`. */
function environment(args: readonly string[]): Record<string, string> {
  expect(args).toContain('--clearenv');
  return Object.fromEntries(
    args.flatMap((a, i) => (a === '--setenv' ? [[args[i + 1] ?? '', args[i + 2] ?? '']] : [])),
  );
}
const at = (args: readonly string[], inside: string) =>
  binds(args).find(([, , to]) => to === inside)?.[0];

const ROWS: [DeployRun, Record<string, string | undefined>, boolean, Record<string, string>][] = [
  [
    'install',
    {
      '/app/code': '--bind',
      '/app/data': undefined,
      '/app/backups': undefined,
      '/app/settings.env': undefined,
    },
    true,
    { HOME: '/app/code/.home' },
  ],
  [
    'build',
    {
      '/app/code': '--bind',
      '/app/data': undefined,
      '/app/backups': undefined,
      '/app/settings.env': undefined,
    },
    false,
    { HOME: '/app/code/.home' },
  ],
  [
    'app',
    {
      '/app/code': '--ro-bind',
      '/app/data': '--bind',
      '/app/backups': undefined,
      '/app/settings.env': '--ro-bind',
    },
    true,
    { HOME: '/app/data', APP_SETTINGS: '/app/settings.env', APP_DATA: '/app/data' },
  ],
  [
    'backup',
    {
      '/app/code': '--ro-bind',
      '/app/data': '--bind',
      '/app/backups': '--bind',
      '/app/settings.env': undefined,
    },
    false,
    { HOME: '/app/data', APP_DATA: '/app/data', APP_BACKUPS: '/app/backups' },
  ],
];

describe('the deploy sandbox table (T069)', () => {
  it('has exactly the four runs', () => {
    expect(Object.keys(RUNS).sort()).toEqual(['app', 'backup', 'build', 'install']);
  });

  it.each(ROWS)('the %s run sees exactly its row', (run, folders, network, env) => {
    const args = deployArgs(run, app, RELEASE);

    for (const [inside, flag] of Object.entries(folders)) expect(at(args, inside)).toBe(flag);
    // Network only through pasta, which the runner attaches: never bwrap's shared network.
    expect(RUNS[run].network).toBe(network);
    expect(args).not.toContain('--share-net');
    expect(environment(args)).toEqual({ PATH: `${node}:/usr/bin:/bin`, ...env });
    expect(args).toEqual(
      expect.arrayContaining([
        ...['--unshare-all', '--unshare-pid', '--die-with-parent', '--new-session'],
      ]),
    );
    expect(args.slice(args.indexOf('--chdir'), args.indexOf('--chdir') + 2)).toEqual([
      '--chdir',
      '/app/code',
    ]);
    // Writable: only the app folder's own parts, each at its fixed place inside.
    const writable = binds(args).filter(([flag]) => flag === '--bind');
    const sources: Record<string, string> = {
      '/app/code': RELEASE,
      '/app/data': app.data,
      '/app/backups': app.backups,
    };
    for (const [, from, to] of writable) expect(from).toBe(sources[to]);
    // From the home folder: the Node install, the release, the app's folders and its settings.
    const fromHome = binds(args)
      .map(([, from]) => from)
      .filter(
        (from) => from === HOME || from.startsWith(`${HOME}/`) || HOME.startsWith(`${from}/`),
      );
    for (const from of fromHome)
      expect([RELEASE, app.data, app.backups, app.settings]).toContain(from);
  });

  it('only the app run gets PORT, the port pasta forwards to it', () => {
    expect(environment(deployArgs('app', app, RELEASE, 8080))).toMatchObject({ PORT: '8080' });
    for (const run of ['install', 'build', 'backup'] as const)
      expect(environment(deployArgs(run, app, RELEASE, 8080)).PORT).toBeUndefined();
  });

  it.each(ROWS.map(([run]) => run))(
    'the %s run binds the system folders and the Node install read-only, a private /tmp, and nothing else',
    (run) => {
      const args = deployArgs(run, app, RELEASE);
      const readOnly = binds(args)
        .filter(([flag, , to]) => flag === '--ro-bind' && !to.startsWith('/app/'))
        .map(([, from, to]) => (expect(to).toBe(from), from));

      expect(readOnly).toEqual(expect.arrayContaining(['/usr', '/etc', node, npm]));
      for (const from of readOnly)
        expect(['/usr', '/bin', '/etc', node, npm].includes(from) || /^\/lib/.test(from)).toBe(
          true,
        );
      expect(args.join(' ')).toContain('--tmpfs /tmp');
      expect(
        binds(args).filter(([, from]) => from === '/tmp' || from.startsWith('/run/user')),
      ).toEqual([]);
    },
  );

  it('the Node install is bound even when it lives under the home folder (nvm), and nothing else of it', () => {
    const home = dirname(dirname(node));
    const nvm = appFolder(home, 'owner/project');
    const release = `${nvm.releases}/${'a'.repeat(40)}-20261013T153000Z`;
    const args = deployArgs('build', nvm, release);
    const fromHome = binds(args)
      .map(([, from]) => from)
      .filter((from) => from === home || from.startsWith(`${home}/`));

    expect(binds(args)).toContainEqual(['--ro-bind', node, node]);
    for (const from of fromHome) expect([node, npm, release]).toContain(from);
  });
});

/** Everything the arguments put under /dev, in order. */
function dev(args: readonly string[]): string[][] {
  return args.flatMap((a, i) => {
    if (a === '--dev') return [[a, args[i + 1] ?? '']];
    const to = /^--(?:ro-|dev-)?bind(?:-try)?$|^--symlink$/.test(a) ? args[i + 2] : undefined;
    if (to?.startsWith('/dev') === true) return [[a, args[i + 1] ?? '', to]];
    if ((a === '--tmpfs' || a === '--dir') && args[i + 1]?.startsWith('/dev') === true)
      return [[a, args[i + 1] ?? '']];
    return [];
  });
}

/** /dev in every sandbox, pinned: a wider one fails here (Owner decision 2026-10-13). */
const DEV = [
  ...['null', 'zero', 'full', 'random', 'urandom'].map((d) => [
    '--dev-bind',
    `/dev/${d}`,
    `/dev/${d}`,
  ]),
  ['--symlink', '/proc/self/fd', '/dev/fd'],
  ['--symlink', '/proc/self/fd/0', '/dev/stdin'],
  ['--symlink', '/proc/self/fd/1', '/dev/stdout'],
  ['--symlink', '/proc/self/fd/2', '/dev/stderr'],
  ['--tmpfs', '/dev/shm'],
];

describe('/dev in both sandboxes (T069, T164)', () => {
  it.each(ROWS.map(([run]) => run))(
    'the %s run sees five devices, the fd links and a private /dev/shm: no tty, pts or ptmx',
    (run) => {
      expect(dev(deployArgs(run, app, RELEASE))).toEqual(DEV);
    },
  );

  it('so does every run of the test sandbox', () => {
    expect(dev(sandboxArgs('/tmp/factory-tests-x', '/tmp/factory-tests-x'))).toEqual(DEV);
  });
});

describe('the pasta arguments (T069, T164)', () => {
  it('the install forwards nothing, in either direction, and maps no gateway to the laptop', () => {
    expect(pastaArgs(undefined, '/tmp/factory-pasta-x/pasta.pid')).toEqual([
      ...['-f', '-q', '--config-net'],
      ...['-t', 'none', '-u', 'none', '-T', 'none', '-U', 'none'],
      '--no-map-gw',
      ...['--dns-forward', '169.254.1.53'],
      ...['-P', '/tmp/factory-pasta-x/pasta.pid'],
    ]);
  });

  it('the app forwards only its port, and only on the laptop’s loopback', () => {
    const args = pastaArgs(8080, '/tmp/factory-pasta-x/pasta.pid');
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual([
      '-t',
      '127.0.0.1/8080',
    ]);
    expect(args.filter((a) => a === '-t')).toHaveLength(1);
  });

  it.each([80, 1023, 0, -1, 65536, 3000.5, Number.NaN])(
    'refuses %s as the app’s port: an integer from 1024 to 65535',
    (port) => {
      expect(() => appPort(port)).toThrow(/1024 to 65535/);
    },
  );

  it.each([1024, 3000, 65535])('accepts %i', (port) => {
    expect(appPort(port)).toBe(port);
  });
});
